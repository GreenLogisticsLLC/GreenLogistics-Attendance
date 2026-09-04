/**
 * Force-apply Customer Respond for a shipment from stored broker mailbox
 * "Question Answered" emails (or rematch by title/route).
 *
 * Contabo:
 *   node scripts/rematch-customer-respond.mjs GOS1000550
 */
import { createRequire } from "module";
import { pathToFileURL } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const gos = (process.argv[2] || "GOS1000550").trim().toUpperCase();

async function main() {
    const lead = await prisma.shipmentLead.findFirst({
        where: { greenOsShipmentId: gos },
    });
    if (!lead) {
        console.error("No shipment", gos);
        process.exit(1);
    }
    console.log("lead", {
        id: lead.shipmentLeadId,
        title: lead.shipmentTitle,
        broker: lead.assignedBrokerId,
        status: lead.status,
        external: lead.externalShipmentId,
        viewUrl: lead.viewUrl,
    });

    const rows = await prisma.brokerMailboxMessage.findMany({
        where: {
            OR: [
                { shipmentLeadId: lead.shipmentLeadId },
                {
                    subject: { contains: "Question Answered" },
                    receivedAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
                },
                {
                    subject: { contains: String(lead.shipmentTitle || "").slice(0, 40) },
                    receivedAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
                },
            ],
        },
        orderBy: { receivedAt: "desc" },
        take: 30,
    });
    console.log("mailbox rows", rows.length);
    for (const r of rows.slice(0, 10)) {
        console.log({
            subject: r.subject,
            matched: r.shipmentLeadId,
            method: r.matchMethod,
            at: r.receivedAt,
        });
    }

    const dist = pathToFileURL(
        path.join(process.cwd(), "dist/modules/email/parsers/uship/uship-lifecycle.detector.js")
    ).href;
    const { applyUshipLifecycleEvent, detectUshipLifecycleEvent } = await import(dist);

    let applied = 0;
    for (const row of rows) {
        const body = `${row.bodyText || ""}\n${row.snippet || ""}`;
        const detected = detectUshipLifecycleEvent(row.subject, body);
        if (
            detected.kind !== "CUSTOMER_RESPOND" &&
            detected.kind !== "CUSTOMER_QUESTION" &&
            detected.kind !== "NEW_MESSAGE"
        ) {
            continue;
        }
        if (!lead.assignedBrokerId) {
            console.warn("no assigned broker — skip apply");
            break;
        }
        const result = await applyUshipLifecycleEvent({
            shipmentLeadId: lead.shipmentLeadId,
            subject: row.subject,
            body,
            actorUserId: lead.assignedBrokerId,
            gmailMessageId: row.gmailMessageId,
            source: "broker_gmail",
        });
        console.log("apply", row.subject.slice(0, 60), result);
        if (result.applied) {
            applied += 1;
            if (!row.shipmentLeadId) {
                await prisma.brokerMailboxMessage.update({
                    where: { messageId: row.messageId },
                    data: {
                        shipmentLeadId: lead.shipmentLeadId,
                        matchMethod: row.matchMethod || "opsRematch",
                    },
                });
            }
            break;
        }
    }

    // Also trigger broker Gmail rematch sync if available.
    try {
        const syncUrl = pathToFileURL(
            path.join(process.cwd(), "dist/modules/email/gmail/broker-gmail-sync.service.js")
        ).href;
        const { brokerGmailSyncService } = await import(syncUrl);
        const sync = await brokerGmailSyncService.syncAllBrokers(25);
        console.log("brokerGmailSync", sync);
    } catch (err) {
        console.warn("sync skip", err instanceof Error ? err.message : err);
    }

    console.log("DONE applied=", applied);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
