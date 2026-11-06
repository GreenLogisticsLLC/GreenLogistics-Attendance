import { prisma } from "../config/database.js";
import { normalizeStatus } from "../modules/shipment/shipment.lifecycle.js";
import { domainEventEngine } from "../modules/shipment/services/domain-event.engine.js";

const MARK = "2026-11-06-gl10065-unvoid";
const LOAD_NUMBER = "GL10065";

const LOAD_FLOW = [
    "LOAD_CREATED",
    "CARRIER_ASSIGNED",
    "RATE_CON_GENERATED",
    "CARRIER_ACCEPTED",
    "PICKUP",
    "IN_TRANSIT",
    "DELIVERED",
    "POD_UPLOADED",
    "CUSTOMER_INVOICE",
    "CARRIER_PAYMENT",
    "DISPATCH",
    "COMPLETED",
    "CLOSED",
];

function statusFromPayload(raw: string | null | undefined): string | null {
    if (!raw) return null;
    try {
        const payload = JSON.parse(raw) as { from?: string; to?: string; status?: string };
        const candidate = payload.from || payload.status || null;
        if (!candidate) return null;
        const normalized = normalizeStatus(String(candidate));
        return LOAD_FLOW.includes(normalized) ? normalized : null;
    } catch {
        return null;
    }
}

/**
 * GL10065 was voided, so Accounting hid it (VOIDED is excluded).
 * Restore the load once so Accounting can see and process it again.
 */
export async function restoreGl10065FromVoided(): Promise<void> {
    const existing = await prisma.setting.findUnique({
        where: {
            category_settingKey: { category: "ops", settingKey: "gl10065_unvoid" },
        },
    });
    if (existing?.settingValue === MARK) return;

    const lead = await prisma.shipmentLead.findFirst({
        where: {
            OR: [{ loadNumber: LOAD_NUMBER }, { loadNumber: "10065" }],
        },
        select: {
            shipmentLeadId: true,
            status: true,
            loadNumber: true,
            carrierName: true,
            carrierProfileId: true,
            carrierRate: true,
        },
    });

    if (!lead) {
        console.warn(`[shipment] ${LOAD_NUMBER} not found — unvoid will retry`);
        return;
    }

    const status = normalizeStatus(lead.status);
    if (status !== "VOIDED") {
        await prisma.setting.upsert({
            where: {
                category_settingKey: { category: "ops", settingKey: "gl10065_unvoid" },
            },
            create: {
                category: "ops",
                settingKey: "gl10065_unvoid",
                settingValue: MARK,
                description: "GL10065 already active — Accounting visibility restore marked done",
            },
            update: { settingValue: MARK },
        });
        return;
    }

    const events = await prisma.domainEvent.findMany({
        where: {
            shipmentLeadId: lead.shipmentLeadId,
            eventType: "STATUS_CHANGED",
        },
        orderBy: { createdAt: "desc" },
        take: 40,
        select: { payloadJson: true, message: true, title: true },
    });

    let restoreTo: string | null = null;
    for (const event of events) {
        const fromPayload = statusFromPayload(event.payloadJson);
        if (fromPayload && fromPayload !== "VOIDED") {
            restoreTo = fromPayload;
            break;
        }
    }

    if (!restoreTo) {
        const hasCarrier =
            Boolean(String(lead.carrierName || "").trim()) ||
            Boolean(lead.carrierProfileId) ||
            (lead.carrierRate != null && Number(lead.carrierRate) > 0);
        restoreTo = hasCarrier ? "CARRIER_ASSIGNED" : "LOAD_CREATED";
    }

    await prisma.shipmentLead.update({
        where: { shipmentLeadId: lead.shipmentLeadId },
        data: { status: restoreTo },
    });

    await domainEventEngine.emit({
        shipmentLeadId: lead.shipmentLeadId,
        eventType: "STATUS_CHANGED",
        title: "Load restored from Voided",
        message: `Load ${LOAD_NUMBER} restored to ${restoreTo} for Accounting`,
        timelineStage: "STATUS_CHANGED",
        payload: {
            loadNumber: LOAD_NUMBER,
            from: "VOIDED",
            to: restoreTo,
            reason: "RESTORE_FOR_ACCOUNTING",
        },
    });

    await prisma.setting.upsert({
        where: {
            category_settingKey: { category: "ops", settingKey: "gl10065_unvoid" },
        },
        create: {
            category: "ops",
            settingKey: "gl10065_unvoid",
            settingValue: MARK,
            description: "GL10065 restored from Voided so Accounting can see the load",
        },
        update: { settingValue: MARK },
    });

    console.log(`[shipment] ${LOAD_NUMBER} restored from VOIDED → ${restoreTo}`);
}
