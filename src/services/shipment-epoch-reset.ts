import { prisma } from "../config/database.js";
import { setCompanyImportAfter } from "../modules/email/services/gmail-import-cutoff.service.js";
import { formatGreenOsShipmentId, GOS_SHIPMENT_START } from "../modules/shipment/shipment.id.js";

/** One-shot: wipe every shipment and import only mail received after this reset runs. */
const SHIPMENTS_EPOCH = "2026-11-02T13:30:00Z";

/**
 * Delete every shipment on every account and ignore Gmail received before
 * the moment this reset runs. Runs once. People, attendance, and carriers stay.
 */
export async function resetShipmentsForEpoch(): Promise<void> {
    const existing = await prisma.setting.findUnique({
        where: {
            category_settingKey: { category: "ops", settingKey: "shipments_epoch" },
        },
    });
    if (existing?.settingValue === SHIPMENTS_EPOCH) return;

    const count = await prisma.shipmentLead.count();
    const now = new Date();
    await prisma.shipmentImportLog.updateMany({ data: { shipmentLeadId: null } });
    await prisma.brokerMailboxMessage.updateMany({ data: { shipmentLeadId: null } });
    await prisma.platformNotification.deleteMany();
    await prisma.shipmentLead.deleteMany();

    await setCompanyImportAfter(now, "shipments-epoch-reset");

    const nextGos = formatGreenOsShipmentId(
        Number.isFinite(GOS_SHIPMENT_START) && GOS_SHIPMENT_START > 0 ? GOS_SHIPMENT_START : 1000001
    );
    await prisma.setting.upsert({
        where: {
            category_settingKey: { category: "shipment", settingKey: "next_green_os_shipment_id" },
        },
        create: {
            category: "shipment",
            settingKey: "next_green_os_shipment_id",
            settingValue: nextGos,
            description: "Next Green OS Shipment ID (GOS1000001… series)",
        },
        update: { settingValue: nextGos },
    });
    await prisma.setting.upsert({
        where: {
            category_settingKey: { category: "shipment", settingKey: "next_load_number" },
        },
        create: {
            category: "shipment",
            settingKey: "next_load_number",
            settingValue: "GL100001",
            description: "Next Green OS Load Number (GL100001… series)",
        },
        update: { settingValue: "GL100001" },
    });
    await prisma.setting.upsert({
        where: {
            category_settingKey: { category: "ops", settingKey: "shipments_epoch" },
        },
        create: {
            category: "ops",
            settingKey: "shipments_epoch",
            settingValue: SHIPMENTS_EPOCH,
            description: "Shipments were cleared and now count from this instant",
        },
        update: { settingValue: SHIPMENTS_EPOCH },
    });

    console.log(
        `[reset] Cleared ${count} shipment(s) on all accounts. New shipments count from ${now.toISOString()}.`
    );
}
