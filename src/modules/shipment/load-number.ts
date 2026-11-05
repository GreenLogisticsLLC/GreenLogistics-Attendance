import { prisma } from "../../config/database.js";

/**
 * Green OS Load Number series: GL10001, GL10002, …
 * Brokers never type a load number — allocation is automatic only.
 */
export const LOAD_NUMBER_PREFIX = "GL";
export const LOAD_NUMBER_START = parseInt(process.env.LOAD_NUMBER_START || "10001", 10);

/** Old series GL100001… is one zero longer than GL10001…. */
export function shortenLoadNumber(raw: string | null | undefined): string | null {
    const n = parseLoadNumberSeq(raw);
    if (n == null || n < 100000 || n > 109999) return null;
    return formatLoadNumber(n - 90000);
}

const GL_RE = /^GL(\d+)$/i;

export function formatLoadNumber(seq: number): string {
    return `${LOAD_NUMBER_PREFIX}${seq}`;
}

export function parseLoadNumberSeq(raw: string | null | undefined): number | null {
    const s = String(raw || "").trim();
    if (!s) return null;
    const gl = s.match(GL_RE);
    if (gl) return parseInt(gl[1], 10);
    // Legacy plain numeric series (75698…) — still readable for max bootstrap.
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    return null;
}

/**
 * Allocate the next company Load Number (GL100001…).
 * Never reused. Stored on the same Shipment card — never creates a separate Load entity.
 */
export async function allocateLoadNumber(): Promise<string> {
    const start =
        Number.isFinite(LOAD_NUMBER_START) && LOAD_NUMBER_START > 0 ? LOAD_NUMBER_START : 10001;

    for (let attempt = 0; attempt < 12; attempt++) {
        const setting = await prisma.setting.findUnique({
            where: {
                category_settingKey: { category: "shipment", settingKey: "next_load_number" },
            },
        });

        let next = start;
        if (setting?.settingValue) {
            const fromSetting = parseLoadNumberSeq(setting.settingValue);
            if (fromSetting != null) next = Math.max(start, fromSetting);
        } else {
            const rows = await prisma.shipmentLead.findMany({
                where: { loadNumber: { not: null } },
                select: { loadNumber: true },
            });
            let max = start - 1;
            for (const row of rows) {
                const n = parseLoadNumberSeq(row.loadNumber);
                if (n != null && n >= start - 1 && n > max) max = n;
            }
            next = Math.max(start, max + 1);
        }

        const candidate = formatLoadNumber(next);
        const clash = await prisma.shipmentLead.findFirst({
            where: {
                OR: [{ loadNumber: candidate }, { loadNumber: String(next) }],
            },
            select: { shipmentLeadId: true },
        });

        await prisma.setting.upsert({
            where: {
                category_settingKey: { category: "shipment", settingKey: "next_load_number" },
            },
            create: {
                category: "shipment",
                settingKey: "next_load_number",
                settingValue: formatLoadNumber(next + 1),
                description: "Next Green OS Load Number (GL10001… series)",
            },
            update: { settingValue: formatLoadNumber(next + 1) },
        });

        if (!clash) return candidate;
    }

    return formatLoadNumber(start + (Date.now() % 100000));
}

/** One pass: GL100023 → GL10023. Leaves already-short numbers alone. */
export async function shortenExistingLoadNumbers(): Promise<void> {
    const mark = "2026-11-05-load-drop-zero";
    const existing = await prisma.setting.findUnique({
        where: {
            category_settingKey: { category: "ops", settingKey: "load_number_drop_zero" },
        },
    });
    if (existing?.settingValue === mark) return;

    const rows = await prisma.shipmentLead.findMany({
        where: { loadNumber: { not: null } },
        select: { shipmentLeadId: true, loadNumber: true },
    });
    let changed = 0;
    let maxSeq = (Number.isFinite(LOAD_NUMBER_START) ? LOAD_NUMBER_START : 10001) - 1;
    for (const row of rows) {
        const current = parseLoadNumberSeq(row.loadNumber);
        const shortened = shortenLoadNumber(row.loadNumber);
        const seq = shortened ? parseLoadNumberSeq(shortened) : current;
        if (seq != null && seq > maxSeq && seq < 100000) maxSeq = seq;
        if (!shortened || !row.loadNumber || shortened === row.loadNumber) continue;
        const clash = await prisma.shipmentLead.findFirst({
            where: {
                loadNumber: shortened,
                NOT: { shipmentLeadId: row.shipmentLeadId },
            },
            select: { shipmentLeadId: true },
        });
        if (clash) continue;
        await prisma.shipmentLead.update({
            where: { shipmentLeadId: row.shipmentLeadId },
            data: { loadNumber: shortened },
        });
        const oldToken = `"${row.loadNumber}"`;
        const newToken = `"${shortened}"`;
        await prisma.$executeRaw`
            UPDATE load_documents
            SET content_json = REPLACE(content_json, ${oldToken}, ${newToken})
            WHERE content_json LIKE ${"%" + row.loadNumber + "%"}
        `;
        changed += 1;
    }
    const next = formatLoadNumber(Math.max(LOAD_NUMBER_START, maxSeq + 1));
    await prisma.setting.upsert({
        where: {
            category_settingKey: { category: "shipment", settingKey: "next_load_number" },
        },
        create: {
            category: "shipment",
            settingKey: "next_load_number",
            settingValue: next,
            description: "Next Green OS Load Number (GL10001… series)",
        },
        update: { settingValue: next },
    });
    await prisma.setting.upsert({
        where: {
            category_settingKey: { category: "ops", settingKey: "load_number_drop_zero" },
        },
        create: {
            category: "ops",
            settingKey: "load_number_drop_zero",
            settingValue: mark,
            description: `Load numbers shortened by one zero (${changed})`,
        },
        update: {
            settingValue: mark,
            description: `Load numbers shortened by one zero (${changed})`,
        },
    });
    console.log(`[load-number] shortened ${changed} load number(s); next ${next}`);
}
