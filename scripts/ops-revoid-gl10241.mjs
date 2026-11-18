/**
 * Re-void GL10241 after Booking Confirmation resurrected it from VOIDED → ACCEPT_GREEN.
 * Idempotent. Run on Contabo: node scripts/ops-revoid-gl10241.mjs
 */
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const LOAD = "GL10241";

async function main() {
    const lead = await prisma.shipmentLead.findFirst({ where: { loadNumber: LOAD } });
    if (!lead) {
        console.log("NOT FOUND", LOAD);
        return;
    }
    console.log("before", {
        loadNumber: lead.loadNumber,
        status: lead.status,
        customerRate: lead.customerRate,
        carrierName: lead.carrierName,
        carrierRate: lead.carrierRate,
        statusBeforeVoid: lead.statusBeforeVoid,
    });

    if (String(lead.status || "").toUpperCase() === "VOIDED") {
        console.log("already VOIDED — ok");
        return;
    }

    await prisma.shipmentLead.update({
        where: { shipmentLeadId: lead.shipmentLeadId },
        data: {
            status: "VOIDED",
            statusBeforeVoid: lead.status || "ACCEPT_GREEN",
            // Keep GL#; clear accounting readiness so it cannot re-enter queues.
            accountingReadyForBilling: false,
            accountingReadyForCarrierPayment: false,
            accountingClosedAt: null,
        },
    });

    try {
        await prisma.domainEvent.create({
            data: {
                shipmentLeadId: lead.shipmentLeadId,
                eventType: "STATUS_CHANGED",
                title: "Load re-voided (ops)",
                message:
                    "GL10241 re-voided — Booking Confirmation had resurrected a voided load into Accounting without customer rate",
                payloadJson: JSON.stringify({
                    loadNumber: LOAD,
                    reason: "OPS_REVOID_GHOST_AFTER_EMAIL_RESURRECTION",
                    from: lead.status,
                    to: "VOIDED",
                }),
            },
        });
    } catch (e) {
        console.warn("domainEvent write failed", e.message);
    }

    const after = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: lead.shipmentLeadId },
        select: { loadNumber: true, status: true, statusBeforeVoid: true },
    });
    console.log("after", after);
}

main()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
