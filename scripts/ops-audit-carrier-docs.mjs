#!/usr/bin/env node
/**
 * Audit carrier packet documents for missing files on disk.
 *   node scripts/ops-audit-carrier-docs.mjs
 *   node scripts/ops-audit-carrier-docs.mjs --load=GL10277
 *
 * Prefer running after `npm run build` so dist/ imports resolve.
 * Falls back to tsx when dist is missing: npx tsx scripts/ops-audit-carrier-docs.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

const args = process.argv.slice(2);
const loadArg = args.find((a) => a.startsWith("--load="));
const loadNumber = loadArg ? loadArg.slice("--load=".length).trim() : "";

async function importFirst(candidates) {
    let lastErr;
    for (const rel of candidates) {
        const abs = path.join(repoRoot, rel);
        if (!fs.existsSync(abs) && !abs.endsWith(".ts")) continue;
        try {
            return await import(pathToFileURL(abs).href);
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error("Unable to import module");
}

const { prisma } = await importFirst(["dist/config/database.js", "src/config/database.ts"]);
const storage = await importFirst([
    "dist/modules/carriers/services/carrier-storage.service.js",
    "src/modules/carriers/services/carrier-storage.service.ts",
]);

const {
    resolveCarrierDocumentAbsolutePath,
    recoverLooseCarrierFile,
    migrateLegacyCarrierUploads,
    CARRIER_UPLOADS_ROOT,
} = storage;

const migrated = migrateLegacyCarrierUploads();
console.log(
    `[audit] canonical=${CARRIER_UPLOADS_ROOT} migrated ${migrated.copied}/${migrated.scanned} legacy file(s)`
);

let carrierIds = null;
if (loadNumber) {
    const lead = await prisma.shipmentLead.findFirst({
        where: { loadNumber },
        select: { carrierProfileId: true, loadNumber: true, shipmentTitle: true },
    });
    if (!lead?.carrierProfileId) {
        console.error(`No carrierProfileId for load ${loadNumber}`);
        process.exit(2);
    }
    carrierIds = [lead.carrierProfileId];
    console.log(
        `[audit] load ${loadNumber} → carrier ${lead.carrierProfileId} (${lead.shipmentTitle || ""})`
    );
}

const docs = await prisma.carrierDocument.findMany({
    where: carrierIds ? { carrierId: { in: carrierIds } } : undefined,
    select: {
        documentId: true,
        carrierId: true,
        documentType: true,
        originalFilename: true,
        storageKey: true,
        checksum: true,
        version: true,
        status: true,
        carrier: { select: { legalName: true } },
    },
    orderBy: [{ carrierId: "asc" }, { documentType: "asc" }],
});

let missing = 0;
let recovered = 0;

for (const doc of docs) {
    let abs = resolveCarrierDocumentAbsolutePath(doc.carrierId, doc.storageKey);
    if (abs) continue;
    const loose = recoverLooseCarrierFile({
        carrierId: doc.carrierId,
        documentType: doc.documentType,
        version: doc.version,
        originalFilename: doc.originalFilename,
        checksum: doc.checksum,
        storageKey: doc.storageKey,
    });
    if (loose) {
        recovered += 1;
        if (loose.storageKey !== doc.storageKey) {
            await prisma.carrierDocument.update({
                where: { documentId: doc.documentId },
                data: { storageKey: loose.storageKey },
            });
        }
        console.log(
            `RECOVERED ${doc.carrier?.legalName || doc.carrierId} ${doc.documentType} v${doc.version} → ${loose.storageKey}`
        );
        continue;
    }
    missing += 1;
    console.log(
        `MISSING  ${doc.carrier?.legalName || doc.carrierId} ${doc.documentType} v${doc.version} ${doc.originalFilename} (${doc.status})`
    );
}

console.log(
    `[audit] total=${docs.length} missing=${missing} recovered=${recovered} ok=${docs.length - missing - recovered}`
);
if (missing) {
    console.log(
        "Re-upload MISSING files from the carrier portal or staff upload. Agreement PDFs can be regenerated from a signature."
    );
    process.exitCode = 1;
}
await prisma.$disconnect();
