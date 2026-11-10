/**
 * Dump viewUrl / email URL fragments for broken Open-in-uShip cards.
 *   node scripts/diagnose-gos-uship-open.mjs GOS1001100 GOS1001106
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

async function dumpOne(gos) {
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
            assignedBroker: {
                select: { firstName: true, lastName: true, username: true },
            },
        },
    });
    console.log("\n==========", gos, "==========");
    if (!lead) {
        console.log("NOT FOUND");
        return;
    }
    const broker = lead.assignedBroker
        ? `${lead.assignedBroker.firstName || ""} ${lead.assignedBroker.lastName || ""}`.trim() ||
          lead.assignedBroker.username
        : null;
    console.log({
        shipmentLeadId: lead.shipmentLeadId,
        greenOsShipmentId: lead.greenOsShipmentId,
        title: lead.shipmentTitle,
        status: lead.status,
        broker,
        pickup: `${lead.pickupCity}, ${lead.pickupState} ${lead.pickupZip}`,
        delivery: `${lead.deliveryCity}, ${lead.deliveryState} ${lead.deliveryZip}`,
        viewUrl: lead.viewUrl,
        externalShipmentId: lead.externalShipmentId,
        imageUrl: lead.imageUrl,
        emailSubject: lead.emailMessage?.subject || null,
        emailSnippet: (lead.emailMessage?.snippet || "").slice(0, 300),
        hasBodyHtml: Boolean(lead.emailMessage?.bodyHtml),
        htmlLen: (lead.emailMessage?.bodyHtml || "").length,
        textLen: (lead.emailMessage?.bodyText || "").length,
    });

    const html = lead.emailMessage?.bodyHtml || "";
    const text = lead.emailMessage?.bodyText || "";
    const blob = html + "\n" + text;
    const urlHits = [...blob.matchAll(/https?:\/\/[^\s"'<>]+/gi)]
        .map((m) => m[0])
        .filter((u) => /uship|listing|shipment|click|track/i.test(u))
        .slice(0, 40);
    console.log("--- URL HITS ---", urlHits.length);
    for (const u of urlHits) console.log(u.slice(0, 500));

    const hrefHits = [...html.matchAll(/href=(?:3D)?["']?([^"'>\s]+)/gi)]
        .map((m) => m[1])
        .filter((u) => /uship|listing|shipment|http/i.test(u))
        .slice(0, 40);
    console.log("--- HREF HITS ---", hrefHits.length);
    for (const u of hrefHits) console.log(String(u).slice(0, 500));

    try {
        const listing = await import(
            pathToFileURL(path.join(process.cwd(), "dist/modules/email/parsers/uship/listing-url.js")).href
        );
        console.log("--- EXTRACTOR ---");
        console.log("ids", listing.listingIdsFromText(html, text, lead.viewUrl, lead.externalShipmentId));
        console.log(
            "refs",
            listing.listingRefsFromText(html, text, lead.viewUrl, lead.notes, lead.imageUrl)
        );
        console.log(
            "trackers",
            listing.trackingUrlsFromText(html, text).map((u) => u.slice(0, 220))
        );
        console.log(
            "fromLead",
            listing.ushipListingUrlFromLead(
                {
                    shipmentTitle: lead.shipmentTitle,
                    viewUrl: lead.viewUrl,
                    externalShipmentId: lead.externalShipmentId,
                    imageUrl: lead.imageUrl,
                    notes: lead.notes,
                },
                [html, text]
            )
        );
        const concrete = await listing.resolveConcreteUshipListing(html, text, lead.viewUrl);
        console.log("resolveConcrete", concrete);
    } catch (err) {
        console.log("extractor failed", err instanceof Error ? err.message : err);
    }
}

async function main() {
    for (const gos of ids) await dumpOne(gos);
}

main()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
