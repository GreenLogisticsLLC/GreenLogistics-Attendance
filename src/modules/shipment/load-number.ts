import { prisma } from "../../config/database.js";

/**
 * Green OS Load Number series: GL100001, GL100002, …
 * Brokers never type a load number — allocation is automatic only.
 */
export const LOAD_NUMBER_PREFIX = "GL";
export const LOAD_NUMBER_START = parseInt(process.env.LOAD_NUMBER_START || "100001", 10);

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
        Number.isFinite(LOAD_NUMBER_START) && LOAD_NUMBER_START > 0 ? LOAD_NUMBER_START : 100001;

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
                description: "Next Green OS Load Number (GL100001… series)",
            },
            update: { settingValue: formatLoadNumber(next + 1) },
        });

        if (!clash) return candidate;
    }

    return formatLoadNumber(start + (Date.now() % 100000));
}
