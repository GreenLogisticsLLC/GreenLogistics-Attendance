/**
 * Dump uShip-related fragments from a shipment email body.
 *   node scripts/dump-uship-email-html.mjs GOS1000550
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
        include: { emailMessage: true },
    });
    if (!lead?.emailMessage) {
        console.error("No email for", gos);
        process.exit(1);
    }
    const html = lead.emailMessage.bodyHtml || "";
    const text = lead.emailMessage.bodyText || "";
    console.log("htmlLen", html.length, "textLen", text.length);

    const urlHits = [...(html + "\n" + text).matchAll(/https?:\/\/[^\s"'<>]+/gi)]
        .map((m) => m[0])
        .filter((u) => /uship|listing|click/i.test(u))
        .slice(0, 30);
    console.log("\n=== URL HITS ===", urlHits.length);
    for (const u of urlHits) console.log(u.slice(0, 400));

    const hrefHits = [...html.matchAll(/href=(?:3D)?["']?([^"'>\s]+)/gi)]
        .map((m) => m[1])
        .filter((u) => /uship|listing|http/i.test(u))
        .slice(0, 30);
    console.log("\n=== HREF HITS ===", hrefHits.length);
    for (const u of hrefHits) console.log(String(u).slice(0, 400));

    try {
        const listing = await import(
            pathToFileURL(path.join(process.cwd(), "dist/modules/email/parsers/uship/listing-url.js")).href
        );
        console.log("\n=== EXTRACTOR ===");
        console.log("ids", listing.listingIdsFromText(html, text));
        console.log("trackers", listing.trackingUrlsFromText(html, text).map((u) => u.slice(0, 200)));
        console.log(
            "fromLead",
            listing.ushipListingUrlFromLead(
                {
                    shipmentTitle: lead.shipmentTitle,
                    viewUrl: lead.viewUrl,
                    externalShipmentId: lead.externalShipmentId,
                    imageUrl: lead.imageUrl,
                },
                [html, text]
            )
        );
    } catch (err) {
        console.log("extractor import failed", err instanceof Error ? err.message : err);
    }

    console.log("\n=== HTML SAMPLE (redacted) ===");
    console.log(html.slice(0, 1800).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"));
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
