/**
 * Bind Instant Alert CTA trackers onto cards that have no concrete uShip URL.
 *   node scripts/repair-gos-uship-cta.mjs GOS1001100 GOS1001106
 */
import { createRequire } from "module";
import { pathToFileURL } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const ids = (process.argv.slice(2).length ? process.argv.slice(2) : ["GOS1001100", "GOS1001106"]).map(
    (s) => String(s || "").trim().toUpperCase()
);

async function main() {
    const listing = await import(
        pathToFileURL(path.join(process.cwd(), "dist/modules/email/parsers/uship/listing-url.js")).href
    );
    for (const gos of ids) {
        const lead = await prisma.shipmentLead.findFirst({
            where: { greenOsShipmentId: gos },
            include: {
                emailMessage: {
                    select: { subject: true, snippet: true, bodyHtml: true, bodyText: true },
                },
            },
        });
        console.log("\n===", gos, "===");
        if (!lead) {
            console.log("NOT FOUND");
            continue;
        }
        const before = { viewUrl: lead.viewUrl, externalShipmentId: lead.externalShipmentId };
        const concrete = listing.ushipListingUrlFromLead(
            {
                viewUrl: lead.viewUrl,
                externalShipmentId: lead.externalShipmentId,
                imageUrl: lead.imageUrl,
                notes: lead.notes,
                shipmentTitle: lead.shipmentTitle,
            },
            [
                lead.emailMessage?.bodyHtml,
                lead.emailMessage?.bodyText,
                lead.emailMessage?.subject,
                lead.emailMessage?.snippet,
            ]
        );
        if (concrete && listing.hasRealListingSlug(concrete)) {
            console.log("already concrete", concrete);
            continue;
        }
        const cta = listing.primaryUshipCtaTracker(
            lead.viewUrl,
            lead.emailMessage?.bodyHtml,
            lead.emailMessage?.bodyText,
            lead.emailMessage?.subject,
            lead.emailMessage?.snippet
        );
        if (!cta) {
            console.log("no CTA found", before);
            continue;
        }
        await prisma.shipmentLead.update({
            where: { shipmentLeadId: lead.shipmentLeadId },
            data: { viewUrl: cta },
        });
        console.log({ before, after: cta });
    }
}

main()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
