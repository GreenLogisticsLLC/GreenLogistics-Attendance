/**
 * Dump uShip-related fragments from a shipment email body.
 *   node scripts/dump-uship-email-html.mjs GOS1000550
 */
import { createRequire } from "module";

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
    const patterns = [
        /https?:\/\/[^\s"'<>]*uship[^\s"'<>]*/gi,
        /href=["'][^"']+["']/gi,
        /listing[^<\s"']{0,80}/gi,
        /ID\s*#?\s*\d+/gi,
    ];
    for (const re of patterns) {
        const hits = [...(html + "\n" + text).matchAll(re)].slice(0, 20).map((m) => m[0]);
        console.log("\n===", re.source.slice(0, 40), "===", hits.length);
        for (const h of hits) console.log(h.slice(0, 300));
    }
    console.log("\n=== HTML HEAD ===");
    console.log(html.slice(0, 2500));
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
