import { prisma } from "../../config/database.js";

/**
 * Permanent Green OS Shipment ID.
 * Format: GOS1000001, GOS1000002, … (company-wide sequence).
 * Brokers never type this — system allocates only.
 */
export const GOS_SHIPMENT_PREFIX = "GOS";
export const GOS_SHIPMENT_START = parseInt(process.env.GOS_SHIPMENT_ID_START || "1000001", 10);

const GOS_SEQ_RE = /^GOS(\d+)$/i;
const LEGACY_DATED_RE = /^GOS-\d{8}-\d+/i;

export function formatGreenOsShipmentId(seq: number): string {
    return `${GOS_SHIPMENT_PREFIX}${seq}`;
}

export function parseGreenOsShipmentSeq(raw: string | null | undefined): number | null {
    const s = String(raw || "").trim();
    if (!s) return null;
    const m = s.match(GOS_SEQ_RE);
    if (m) return parseInt(m[1], 10);
    return null;
}

export function isLegacyGreenOsShipmentId(raw: string | null | undefined): boolean {
    const s = String(raw || "").trim();
    if (!s) return true;
    if (LEGACY_DATED_RE.test(s)) return true;
    return parseGreenOsShipmentSeq(s) == null;
}

async function readNextSeq(): Promise<number> {
    const start =
        Number.isFinite(GOS_SHIPMENT_START) && GOS_SHIPMENT_START > 0 ? GOS_SHIPMENT_START : 1000001;

    const setting = await prisma.setting.findUnique({
        where: {
            category_settingKey: { category: "shipment", settingKey: "next_green_os_shipment_id" },
        },
    });
    if (setting?.settingValue) {
        const fromSetting = parseGreenOsShipmentSeq(setting.settingValue);
        if (fromSetting != null) return Math.max(start, fromSetting);
        if (/^\d+$/.test(setting.settingValue)) {
            return Math.max(start, parseInt(setting.settingValue, 10));
        }
    }

    const rows = await prisma.shipmentLead.findMany({
        where: { greenOsShipmentId: { not: null } },
        select: { greenOsShipmentId: true },
    });
    let max = start - 1;
    for (const row of rows) {
        const n = parseGreenOsShipmentSeq(row.greenOsShipmentId);
        if (n != null && n > max) max = n;
    }
    return Math.max(start, max + 1);
}

async function writeNextSeq(next: number): Promise<void> {
    await prisma.setting.upsert({
        where: {
            category_settingKey: { category: "shipment", settingKey: "next_green_os_shipment_id" },
        },
        create: {
            category: "shipment",
            settingKey: "next_green_os_shipment_id",
            settingValue: formatGreenOsShipmentId(next),
            description: "Next Green OS Shipment ID (GOS1000001… series)",
        },
        update: { settingValue: formatGreenOsShipmentId(next) },
    });
}

/**
 * Allocate the next permanent Shipment ID: GOS1000001, GOS1000002, …
 */
export async function allocateGreenOsShipmentId(_createdAt = new Date()): Promise<string> {
    const start =
        Number.isFinite(GOS_SHIPMENT_START) && GOS_SHIPMENT_START > 0 ? GOS_SHIPMENT_START : 1000001;

    for (let attempt = 0; attempt < 12; attempt++) {
        const next = await readNextSeq();
        const candidate = formatGreenOsShipmentId(Math.max(start, next));
        const clash = await prisma.shipmentLead.findFirst({
            where: { greenOsShipmentId: candidate },
            select: { shipmentLeadId: true },
        });

        const seq = parseGreenOsShipmentSeq(candidate) || start;
        await writeNextSeq(seq + 1);

        if (!clash) return candidate;
    }

    return formatGreenOsShipmentId(start + (Date.now() % 100000));
}

/** Ensure row has a permanent sequential ID (idempotent for GOS######). */
export async function ensureGreenOsShipmentId(shipmentLeadId: string): Promise<string> {
    const row = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId },
        select: { greenOsShipmentId: true },
    });
    if (!row) throw Object.assign(new Error("Shipment not found"), { status: 404 });
    if (row.greenOsShipmentId && !isLegacyGreenOsShipmentId(row.greenOsShipmentId)) {
        return row.greenOsShipmentId;
    }

    const id = await allocateGreenOsShipmentId();
    await prisma.shipmentLead.update({
        where: { shipmentLeadId },
        data: { greenOsShipmentId: id },
    });
    return id;
}

/** Fill null/empty IDs only (new sequential series). */
export async function backfillMissingGreenOsShipmentIds(limit = 500): Promise<number> {
    const rows = await prisma.shipmentLead.findMany({
        where: { OR: [{ greenOsShipmentId: null }, { greenOsShipmentId: "" }] },
        select: { shipmentLeadId: true },
        take: limit,
        orderBy: { createdAt: "asc" },
    });
    let n = 0;
    for (const row of rows) {
        try {
            await ensureGreenOsShipmentId(row.shipmentLeadId);
            n += 1;
        } catch {
            /* unique race — skip */
        }
    }
    return n;
}

/**
 * Rewrite ALL shipment IDs to GOS1000001… ordered by createdAt.
 * Converts legacy GOS-YYYYMMDD-#### and any non-sequential values.
 * Safe to run on boot — no-op when every row is already sequential from START.
 */
export async function remigrateAllGreenOsShipmentIds(): Promise<number> {
    const start =
        Number.isFinite(GOS_SHIPMENT_START) && GOS_SHIPMENT_START > 0 ? GOS_SHIPMENT_START : 1000001;

    const rows = await prisma.shipmentLead.findMany({
        select: { shipmentLeadId: true, greenOsShipmentId: true },
        orderBy: { createdAt: "asc" },
    });
    if (!rows.length) return 0;

    const needsRewrite = rows.some(
        (r, i) => r.greenOsShipmentId !== formatGreenOsShipmentId(start + i)
    );
    if (!needsRewrite) {
        await writeNextSeq(start + rows.length);
        return 0;
    }

    // Phase 1 — temp unique values to avoid @@unique clashes while swapping.
    for (const row of rows) {
        await prisma.shipmentLead.update({
            where: { shipmentLeadId: row.shipmentLeadId },
            data: { greenOsShipmentId: `__TMP_GOS_${row.shipmentLeadId}` },
        });
    }

    // Phase 2 — assign final sequential IDs.
    let seq = start;
    for (const row of rows) {
        await prisma.shipmentLead.update({
            where: { shipmentLeadId: row.shipmentLeadId },
            data: { greenOsShipmentId: formatGreenOsShipmentId(seq) },
        });
        seq += 1;
    }

    await writeNextSeq(seq);
    return rows.length;
}
