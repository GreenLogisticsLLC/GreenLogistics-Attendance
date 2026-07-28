import { prisma } from "../../config/database.js";

/**
 * Permanent Green OS Shipment ID.
 * Format: GOS-YYYYMMDD-#### (day-scoped sequence). Never reused / never changed.
 */
export async function allocateGreenOsShipmentId(createdAt = new Date()): Promise<string> {
    const day = createdAt.toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `GOS-${day}-`;

    for (let attempt = 0; attempt < 8; attempt++) {
        const existing = await prisma.shipmentLead.count({
            where: { greenOsShipmentId: { startsWith: prefix } },
        });
        const candidate = `${prefix}${String(existing + 1 + attempt).padStart(4, "0")}`;
        const clash = await prisma.shipmentLead.findUnique({
            where: { greenOsShipmentId: candidate },
            select: { shipmentLeadId: true },
        });
        if (!clash) return candidate;
    }

    return `GOS-${day}-${Date.now().toString(36).toUpperCase()}`;
}

/** Ensure legacy rows get a permanent ID (idempotent). */
export async function ensureGreenOsShipmentId(shipmentLeadId: string): Promise<string> {
    const row = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId },
        select: { greenOsShipmentId: true, createdAt: true },
    });
    if (!row) throw Object.assign(new Error("Shipment not found"), { status: 404 });
    if (row.greenOsShipmentId) return row.greenOsShipmentId;

    const id = await allocateGreenOsShipmentId(row.createdAt);
    await prisma.shipmentLead.update({
        where: { shipmentLeadId },
        data: { greenOsShipmentId: id },
    });
    return id;
}

export async function backfillMissingGreenOsShipmentIds(limit = 500): Promise<number> {
    const rows = await prisma.shipmentLead.findMany({
        where: { OR: [{ greenOsShipmentId: null }, { greenOsShipmentId: "" }] },
        select: { shipmentLeadId: true, createdAt: true },
        take: limit,
        orderBy: { createdAt: "asc" },
    });
    let n = 0;
    for (const row of rows) {
        const id = await allocateGreenOsShipmentId(row.createdAt);
        try {
            await prisma.shipmentLead.update({
                where: { shipmentLeadId: row.shipmentLeadId },
                data: { greenOsShipmentId: id },
            });
            n += 1;
        } catch {
            /* unique race — skip */
        }
    }
    return n;
}
