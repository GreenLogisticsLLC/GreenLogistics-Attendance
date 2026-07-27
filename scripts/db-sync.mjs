/**
 * Push Prisma schema to the SAME absolute SQLite DB the app uses at runtime.
 * Avoids the Prisma CLI (schema-relative) vs runtime (cwd-relative) split.
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

const defaultDb = path.join(root, "data", "attendance.db");
const legacyDb = path.join(root, "prisma", "data", "attendance.db");

function resolveSqliteFile(raw) {
    if (!raw || !String(raw).startsWith("file:")) {
        return defaultDb;
    }
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
    if (!path.isAbsolute(filePath)) {
        return path.resolve(root, filePath);
    }
    return filePath;
}

function run(cmd) {
    console.log("[db-sync]", cmd);
    execSync(cmd, { cwd: root, stdio: "inherit", env: process.env, shell: true });
}

const rawUrl = process.env.DATABASE_URL || "file:./data/attendance.db";
const isPostgres = /^postgres(ql)?:\/\//i.test(rawUrl);

if (isPostgres) {
    const schema = path.join(root, "prisma", "schema.postgresql.prisma");
    console.log("[db-sync] PostgreSQL — using", schema);
    run(`npx prisma generate --schema "${schema}"`);
    run(`npx prisma db push --schema "${schema}"`);
    process.exit(0);
}

const dbFile = resolveSqliteFile(rawUrl);
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const legacySize = fs.existsSync(legacyDb) ? fs.statSync(legacyDb).size : 0;
const targetSize = fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0;
if (legacySize > 0 && targetSize === 0) {
    fs.copyFileSync(legacyDb, dbFile);
    console.log(`[db-sync] Copied legacy DB ${legacyDb} → ${dbFile}`);
}

const absUrl = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.DATABASE_URL = absUrl;
console.log("[db-sync] DATABASE_URL=", absUrl);

const schema = path.join(root, "prisma", "schema.prisma");
run(`npx prisma generate --schema "${schema}"`);
// Prisma 6 has no --url on db push; rely on process.env.DATABASE_URL (set above).
run(`npx prisma db push --schema "${schema}"`);
