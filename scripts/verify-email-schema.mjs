/**
 * Verifies email importer tables exist. Exits 1 if missing (fails Contabo deploy).
 * Usage: node scripts/verify-email-schema.mjs
 */
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

const require = createRequire(import.meta.url);
const defaultDb = path.join(root, "data", "attendance.db");
const legacyDb = path.join(root, "prisma", "data", "attendance.db");

function resolveSqliteFile(raw) {
    if (!raw || !String(raw).startsWith("file:")) return defaultDb;
    let filePath = String(raw).slice("file:".length);
    if (filePath.startsWith("///")) {
        filePath = filePath.slice(2);
        if (process.platform === "win32" && /^\/[A-Za-z]:/.test(filePath)) {
            filePath = filePath.slice(1);
        }
    }
    const rel = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (
        !path.isAbsolute(filePath) &&
        (rel === "data/attendance.db" || rel === "prisma/data/attendance.db")
    ) {
        return defaultDb;
    }
    if (!path.isAbsolute(filePath)) return path.resolve(root, filePath);
    return filePath;
}

const raw = process.env.DATABASE_URL || "file:./data/attendance.db";
if (/^postgres(ql)?:\/\//i.test(raw)) {
    process.env.DATABASE_URL = raw;
} else {
    const dbFile = resolveSqliteFile(raw);
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const legacySize = fs.existsSync(legacyDb) ? fs.statSync(legacyDb).size : 0;
    const targetSize = fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0;
    if (legacySize > 0 && targetSize === 0) {
        fs.copyFileSync(legacyDb, dbFile);
        console.log(`[verify-email-schema] Copied legacy DB → ${dbFile}`);
    }
    process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
}

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const required = ["email_messages", "shipment_leads", "shipment_import_logs"];

async function main() {
    console.log("[verify-email-schema] DATABASE_URL=", process.env.DATABASE_URL);
    const missing = [];
    for (const table of required) {
        try {
            await prisma.$queryRawUnsafe(`SELECT 1 FROM ${table} LIMIT 1`);
            console.log(`[verify-email-schema] OK  ${table}`);
        } catch (err) {
            missing.push(table);
            console.error(`[verify-email-schema] MISSING  ${table}:`, err?.message || err);
        }
    }
    await prisma.$disconnect();
    if (missing.length) {
        console.error(
            `[verify-email-schema] FAIL — missing tables: ${missing.join(", ")}. Run: npm run db:push`
        );
        process.exit(1);
    }
    console.log("[verify-email-schema] All email tables present.");
}

main().catch(async (err) => {
    console.error("[verify-email-schema] Error:", err);
    try {
        await prisma.$disconnect();
    } catch {
        /* ignore */
    }
    process.exit(1);
});
