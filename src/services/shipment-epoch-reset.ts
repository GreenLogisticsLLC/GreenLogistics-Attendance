import { prisma } from "../config/database.js";
import { setCompanyImportAfter } from "../modules/email/services/gmail-import-cutoff.service.js";
import {
    formatGreenOsShipmentId,
    GOS_SHIPMENT_START,
    parseGreenOsShipmentSeq,
} from "../modules/shipment/shipment.id.js";
import { SHIPMENTS_FROM } from "./shipment-cutoff.js";

/** New value so the next boot deletes the old Other Shipment rows again. */
const SHIPMENTS_EPOCH = "2026-11-02T17:38+04";

const OLD_SHIPMENTS = {
    OR: [
        { receivedAt: { lt: SHIPMENTS_FROM } },
        { AND: [{ receivedAt: null }, { createdAt: { lt: SHIPMENTS_FROM } }] },
    ],
};

async function tryStep(label: string, fn: () => Promise<unknown>) {
    try {
        await fn();
    } catch (err) {
        console.warn(`[reset] ${label} failed:`, err);
    }
}

async function deleteOldShipments(): Promise<number> {
    const old = await prisma.shipmentLead.findMany({
        where: OLD_SHIPMENTS,
        select: { shipmentLeadId: true },
    });
    const ids = old.map((row) => row.shipmentLeadId);
    if (!ids.length) return 0;

    for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const where = { shipmentLeadId: { in: chunk } };
        await tryStep("tracking positions", () => prisma.trackingPosition.deleteMany({ where }));
        await tryStep("tracking events", () => prisma.trackingIntegrationEvent.deleteMany({ where }));
        await tryStep("tracking", () => prisma.shipmentTracking.deleteMany({ where }));
        await tryStep("load documents", () => prisma.loadDocument.deleteMany({ where }));
        await tryStep("domain events", () => prisma.domainEvent.deleteMany({ where }));
        await tryStep("broker problems", () => prisma.brokerResponseProblem.deleteMany({ where }));
        await tryStep("late problems", () => prisma.loadLateProblem.deleteMany({ where }));
        await tryStep("ops comments", () => prisma.shipmentOpsComment.deleteMany({ where }));
        await tryStep("timeline", () => prisma.shipmentTimelineEvent.deleteMany({ where }));
        await tryStep("import logs", () =>
            prisma.shipmentImportLog.updateMany({ where, data: { shipmentLeadId: null } })
        );
        await tryStep("mailbox", () =>
            prisma.brokerMailboxMessage.updateMany({ where, data: { shipmentLeadId: null } })
        );
        await tryStep("notifications", () => prisma.platformNotification.deleteMany({ where }));
        await tryStep("leads", () => prisma.shipmentLead.deleteMany({ where: { shipmentLeadId: { in: chunk } } }));
    }

    const still = await prisma.shipmentLead.count({ where: OLD_SHIPMENTS });
    if (still > 0) {
        await tryStep("foreign keys off", () => prisma.$executeRawUnsafe("PRAGMA foreign_keys = OFF"));
        for (let i = 0; i < ids.length; i += 200) {
            const list = ids
                .slice(i, i + 200)
                .map((id) => `'${id.replace(/'/g, "")}'`)
                .join(",");
            await tryStep("raw delete", () =>
                prisma.$executeRawUnsafe(
                    `DELETE FROM shipment_leads WHERE shipment_lead_id IN (${list})`
                )
            );
        }
        await tryStep("foreign keys on", () => prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON"));
    }

    return ids.length;
}

/**
 * Remove shipments from before 17:38 Yerevan on 2 Nov 2026.
 * Mail after that instant can still be imported and assigned. Runs once.
 */
export async function resetShipmentsForEpoch(): Promise<void> {
    const existing = await prisma.setting.findUnique({
        where: {
            category_settingKey: { category: "ops", settingKey: "shipments_epoch" },
        },
    });
    if (existing?.settingValue === SHIPMENTS_EPOCH) return;

    const removed = await deleteOldShipments();
    await setCompanyImportAfter(SHIPMENTS_FROM, "shipments-epoch-reset");

    const remaining = await prisma.shipmentLead.findMany({
        select: { greenOsShipmentId: true },
    });
    let max = (Number.isFinite(GOS_SHIPMENT_START) && GOS_SHIPMENT_START > 0 ? GOS_SHIPMENT_START : 1000001) - 1;
    for (const row of remaining) {
        const n = parseGreenOsShipmentSeq(row.greenOsShipmentId);
        if (n != null && n > max) max = n;
    }
    const nextGos = formatGreenOsShipmentId(max + 1);
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
    if (remaining.length === 0) {
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
    }
    await prisma.setting.upsert({
        where: {
            category_settingKey: { category: "ops", settingKey: "shipments_epoch" },
        },
        create: {
            category: "ops",
            settingKey: "shipments_epoch",
            settingValue: SHIPMENTS_EPOCH,
            description: "Shipments before 17:38 Yerevan on 2 Nov 2026 were removed",
        },
        update: { settingValue: SHIPMENTS_EPOCH },
    });

    console.log(
        `[reset] Removed ${removed} shipment(s) from before ${SHIPMENTS_FROM.toISOString()} (17:38 Yerevan).`
    );
}
