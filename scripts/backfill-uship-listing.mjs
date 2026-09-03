/**
 * Resolve and persist the uShip listing URL for a Green OS shipment.
 *   node scripts/backfill-uship-listing.mjs GOS1000550
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
        include: {
            emailMessage: {
                select: {
                    subject: true,
                    snippet: true,
                    bodyText: true,
                    bodyHtml: true,
                    gmailMessageId: true,
                },
            },
        },
    });
    if (!lead) {
        console.error("Shipment not found:", gos);
        process.exit(1);
    }

    const broker = lead.assignedBrokerId
        ? await prisma.user.findUnique({
              where: { userId: lead.assignedBrokerId },
              select: { firstName: true, lastName: true, username: true },
          })
        : null;

    console.log("=== BEFORE ===");
    console.log({
        shipmentLeadId: lead.shipmentLeadId,
        greenOsShipmentId: lead.greenOsShipmentId,
        title: lead.shipmentTitle,
        broker: broker ? `${broker.firstName} ${broker.lastName} (${broker.username})` : null,
        pickup: `${lead.pickupCity}, ${lead.pickupState} ${lead.pickupZip}`,
        delivery: `${lead.deliveryCity}, ${lead.deliveryState} ${lead.deliveryZip}`,
        miles: lead.miles,
        viewUrl: lead.viewUrl,
        externalShipmentId: lead.externalShipmentId,
        emailSubject: lead.emailMessage?.subject || null,
        emailSnippet: (lead.emailMessage?.snippet || "").slice(0, 240),
        hasBodyHtml: Boolean(lead.emailMessage?.bodyHtml),
        hasBodyText: Boolean(lead.emailMessage?.bodyText),
    });

    const { crmService } = await import(
        pathToFileURL(path.join(process.cwd(), "dist/modules/crm/services/crm.service.js")).href
    );
    const url = await crmService.resolveUshipListingUrl(lead.shipmentLeadId);
    const after = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: lead.shipmentLeadId },
        select: { viewUrl: true, externalShipmentId: true },
    });
    console.log("=== AFTER ===");
    console.log({ resolved: url, viewUrl: after?.viewUrl, externalShipmentId: after?.externalShipmentId });
}

main()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
