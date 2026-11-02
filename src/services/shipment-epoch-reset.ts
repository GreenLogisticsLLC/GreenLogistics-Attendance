import { prisma } from "../config/database.js";
import { config } from "../config/env.js";
import { setCompanyImportAfter } from "../modules/email/services/gmail-import-cutoff.service.js";
import { formatGreenOsShipmentId, GOS_SHIPMENT_START } from "../modules/shipment/shipment.id.js";
import { zonedDateTime } from "../utils/helpers.js";

/** One-shot board reset: shipments count from the start of this calendar day. */
const SHIPMENTS_EPOCH = "2026-11-02";

/**
 * Delete every shipment so Green OS starts empty, and ignore Gmail received
 * before the start of SHIPMENTS_EPOCH in the company timezone.
 * Runs once. People, attendance, and carrier profiles stay.
 */
export async function resetShipmentsForEpoch(): Promise<void> {
    const existing = await prisma.setting.findUnique({
        where: {
            category_settingKey: { category: "ops", settingKey: "shipments_epoch" },
        },
    });
    if (existing?.settingValue === SHIPMENTS_EPOCH) return;

    const count = await prisma.shipmentLead.count();
    await prisma.shipmentImportLog.updateMany({ data: { shipmentLeadId: null } });
    await prisma.shipmentLead.deleteMany();

    const start = zonedDateTime(SHIPMENTS_EPOCH, "00:00", config.timezone);
    await setCompanyImportAfter(start, "shipments-epoch-reset");

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
            description: "Shipments were cleared and now count from this day",
        },
        update: { settingValue: SHIPMENTS_EPOCH },
    });

    console.log(
        `[reset] Cleared ${count} shipment(s). New shipments count from ${SHIPMENTS_EPOCH} (${config.timezone}).`
    );
}
