import { prisma } from "../config/database.js";
import { normalizeStatus } from "../modules/shipment/shipment.lifecycle.js";

const MARK = "2026-11-03-gos1000040-bid-only";
const GOS_ID = "GOS1000040";

const WON_EVENTS = [
    "CUSTOMER_ACCEPTED",
    "BOOKED",
    "LOAD_CREATED",
    "LOAD_NUMBER_ASSIGNED",
    "LOAD_NUMBER_RECEIVED",
];

const WON_STAGES = [
    "CUSTOMER_ACCEPTED",
    "ACCEPT_GREEN",
    "ACCEPTED",
    "BOOKED",
    "LOAD_CREATED",
    "LOAD_NUMBER_ASSIGNED",
];

/**
 * GOS1000040 only had a uShip bid. A false Accept Green created GL100003.
 * Put the card back on Bid Submitted and drop that load number. Runs once.
 */
export async function revertFalseAcceptGos1000040(): Promise<void> {
    const existing = await prisma.setting.findUnique({
        where: {
            category_settingKey: { category: "ops", settingKey: "gos1000040_bid_only" },
        },
    });
    if (existing?.settingValue === MARK) return;

    const lead = await prisma.shipmentLead.findFirst({
        where: { greenOsShipmentId: GOS_ID },
        select: { shipmentLeadId: true, status: true, loadNumber: true },
    });
    if (!lead) {
        console.warn(`[shipment] ${GOS_ID} not found — false accept revert will retry`);
        return;
    }

    const status = normalizeStatus(lead.status);
    const terminal = ["LOST", "ACCEPTED_ANOTHER_COMPANY", "DELETED_FROM_CUSTOMER"].includes(status);
    if (!terminal) {
        await prisma.shipmentLead.update({
            where: { shipmentLeadId: lead.shipmentLeadId },
            data: {
                status: "BID_SUBMITTED",
                loadNumber: null,
            },
        });
        await prisma.domainEvent.deleteMany({
            where: {
                shipmentLeadId: lead.shipmentLeadId,
                eventType: { in: WON_EVENTS },
            },
        });
        await prisma.shipmentTimelineEvent.deleteMany({
            where: {
                shipmentLeadId: lead.shipmentLeadId,
                stage: { in: WON_STAGES },
            },
        });
    }

    await prisma.setting.upsert({
        where: {
            category_settingKey: { category: "ops", settingKey: "gos1000040_bid_only" },
        },
        create: {
            category: "ops",
            settingKey: "gos1000040_bid_only",
            settingValue: MARK,
            description: "GOS1000040 was a bid only — removed false Accept Green / Load Created",
        },
        update: { settingValue: MARK },
    });
    console.log(
        `[shipment] ${GOS_ID} returned to Bid Submitted (was ${lead.status}, load ${lead.loadNumber || "none"})`
    );
}
