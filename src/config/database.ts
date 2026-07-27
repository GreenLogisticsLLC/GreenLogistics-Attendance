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

    let filePath = raw.slice("file:".length);

    if (filePath.startsWith("///")) {
        filePath = filePath.slice(2);
        if (process.platform === "win32" && /^\/[A-Za-z]:/.test(filePath)) {
            filePath = filePath.slice(1);
        }
    } else if (filePath.startsWith("//")) {
        return raw;
    }

    // Map common relative forms onto the canonical project data file
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
    return `file:${normalized}`;
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

    // Prefer the larger existing DB (legacy CLI path often held the real data).
    if (legacySize > 0 && targetSize === 0) {
        fs.copyFileSync(legacyPrismaDbFile, targetFile);
        console.log(
            `[db] Copied SQLite from prisma/data/attendance.db → ${targetFile} (${legacySize} bytes)`
        );
    } else if (!targetExists && legacySize === 0) {
        // Touch empty file; prisma db push will create schema
        fs.closeSync(fs.openSync(targetFile, "a"));
    }
}

const resolvedUrl = resolveDatabaseUrl();
process.env.DATABASE_URL = resolvedUrl;

export const prisma = new PrismaClient();

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
