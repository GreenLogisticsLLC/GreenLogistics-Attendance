import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultDbFile = path.join(projectRoot, "data", "attendance.db");
const legacyPrismaDbFile = path.join(projectRoot, "prisma", "data", "attendance.db");

/**
 * SQLite relative paths are resolved differently by Prisma CLI (schema dir)
 * vs PrismaClient (process.cwd()). Always use an absolute file: URL so
 * generate/db push/runtime share one database.
 */
export function resolveDatabaseUrl(raw = process.env.DATABASE_URL || "file:./data/attendance.db"): string {
    if (!raw.startsWith("file:")) {
        return raw;
    }

    // Split query string (Prisma SQLite params)
    const qIndex = raw.indexOf("?");
    const filePart = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
    const existingQuery = qIndex >= 0 ? raw.slice(qIndex + 1) : "";

    let filePath = filePart.slice("file:".length);

    if (filePath.startsWith("///")) {
        filePath = filePath.slice(2);
        if (process.platform === "win32" && /^\/[A-Za-z]:/.test(filePath)) {
            filePath = filePath.slice(1);
        }
    } else if (filePath.startsWith("//")) {
        return appendSqliteParams(raw, existingQuery);
    }

    const normalizedRel = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (
        !path.isAbsolute(filePath) &&
        (normalizedRel === "data/attendance.db" ||
            normalizedRel === "prisma/data/attendance.db" ||
            normalizedRel.endsWith("/data/attendance.db"))
    ) {
        filePath = defaultDbFile;
    } else if (!path.isAbsolute(filePath)) {
        filePath = path.resolve(projectRoot, filePath);
    }

    ensureCanonicalSqliteFile(filePath);

    const normalized = filePath.replace(/\\/g, "/");
    return appendSqliteParams(`file:${normalized}`, existingQuery);
}

/** Single connection + long socket timeout — required for SQLite under concurrent writers. */
function appendSqliteParams(baseUrl: string, existingQuery: string): string {
    const params = new URLSearchParams(existingQuery);
    if (!params.has("connection_limit")) params.set("connection_limit", "1");
    if (!params.has("socket_timeout")) params.set("socket_timeout", "60");
    if (!params.has("busy_timeout")) params.set("busy_timeout", "60000");
    const q = params.toString();
    const bare = baseUrl.split("?")[0];
    return q ? `${bare}?${q}` : bare;
}

function ensureCanonicalSqliteFile(targetFile: string) {
    const dir = path.dirname(targetFile);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const targetExists = fs.existsSync(targetFile);
    const targetSize = targetExists ? fs.statSync(targetFile).size : 0;
    const legacyExists = fs.existsSync(legacyPrismaDbFile);
    const legacySize = legacyExists ? fs.statSync(legacyPrismaDbFile).size : 0;

    if (legacySize > 0 && targetSize === 0) {
        fs.copyFileSync(legacyPrismaDbFile, targetFile);
        console.log(
            `[db] Copied SQLite from prisma/data/attendance.db → ${targetFile} (${legacySize} bytes)`
        );
    } else if (!targetExists && legacySize === 0) {
        fs.closeSync(fs.openSync(targetFile, "a"));
    }
}

const resolvedUrl = resolveDatabaseUrl();
process.env.DATABASE_URL = resolvedUrl;

export const prisma = new PrismaClient({
    datasources: { db: { url: resolvedUrl } },
});

/** Depth counter: email poller skips ticks while admin writes run. */
let adminWriteDepth = 0;

export function beginAdminWrite(): void {
    adminWriteDepth += 1;
}

export function endAdminWrite(): void {
    adminWriteDepth = Math.max(0, adminWriteDepth - 1);
}

export function isAdminWriteActive(): boolean {
    return adminWriteDepth > 0;
}

export function isDbBusyError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /busy|locked|timeout|Socket timeout|Unable to open|database is locked/i.test(msg);
}

export async function withDbRetry<T>(
    label: string,
    fn: () => Promise<T>,
    attempts = 10
): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!isDbBusyError(err) || i === attempts - 1) throw err;
            const waitMs = Math.min(4000, 150 * Math.pow(1.6, i)) + Math.floor(Math.random() * 100);
            console.warn(`[db] ${label} busy — retry ${i + 1}/${attempts} in ${waitMs}ms`);
            await new Promise((r) => setTimeout(r, waitMs));
        }
    }
    throw lastErr;
}

/** Reduce SQLite lock timeouts under concurrent email poller + admin writes. */
export async function configureSqlite(): Promise<void> {
    if (!resolvedUrl.startsWith("file:")) return;
    try {
        await prisma.$executeRawUnsafe("PRAGMA journal_mode=WAL;");
        await prisma.$executeRawUnsafe("PRAGMA busy_timeout=60000;");
        await prisma.$executeRawUnsafe("PRAGMA synchronous=NORMAL;");
        await prisma.$executeRawUnsafe("PRAGMA foreign_keys=ON;");
        console.log("[db] SQLite WAL + busy_timeout=60s + connection_limit=1");
    } catch (err) {
        console.warn("[db] Could not set SQLite pragmas:", err);
    }
}

export function getResolvedDatabaseUrl(): string {
    return resolvedUrl;
}

export function getProjectRoot(): string {
    return projectRoot;
}

export async function emailTablesExist(): Promise<boolean> {
    try {
        await prisma.$queryRawUnsafe("SELECT 1 FROM shipment_leads LIMIT 1");
        await prisma.$queryRawUnsafe("SELECT 1 FROM shipment_import_logs LIMIT 1");
        await prisma.$queryRawUnsafe("SELECT 1 FROM email_messages LIMIT 1");
        return true;
    } catch {
        return false;
    }
}
