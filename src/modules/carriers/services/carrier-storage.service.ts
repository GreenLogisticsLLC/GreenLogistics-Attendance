import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { MAX_UPLOAD_BYTES } from "../constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Canonical carrier-doc storage under the process working directory.
 * Prefer cwd so `tsx` (src/) and `node dist/` share the same files — and so
 * `tsc` / dist rebuilds do not wipe uploaded Broker–Carrier Agreements.
 * Legacy roots (src/uploads, dist/uploads, __dirname-relative) are still resolved when reading.
 */
export const CARRIER_UPLOADS_ROOT = path.join(process.cwd(), "uploads", "carriers");

const LEGACY_CARRIER_UPLOADS_ROOTS = [
    path.join(__dirname, "..", "..", "..", "uploads", "carriers"),
    path.join(process.cwd(), "src", "uploads", "carriers"),
    path.join(process.cwd(), "dist", "uploads", "carriers"),
];

/** Deny-list only — carriers may upload any document format (PDF, Word, photos, HEIC, etc.). */
const BLOCKED_EXT = new Set([
    ".exe",
    ".bat",
    ".cmd",
    ".com",
    ".msi",
    ".js",
    ".mjs",
    ".cjs",
    ".vbs",
    ".ps1",
    ".sh",
    ".bash",
    ".dll",
    ".scr",
    ".jar",
    ".apk",
    ".dmg",
    ".app",
    ".php",
    ".phtml",
    ".asp",
    ".aspx",
    ".cgi",
    ".pl",
    ".py",
    ".rb",
    ".html",
    ".htm",
    ".shtml",
    ".svg",
    ".wasm",
]);

const BLOCKED_MIME_PREFIXES = ["application/x-msdownload", "application/x-executable", "application/x-sh"];
const BLOCKED_MIME = new Set([
    "application/javascript",
    "text/javascript",
    "application/x-javascript",
    "text/html",
    "image/svg+xml",
    "application/wasm",
]);

function safeFileName(name: string): string {
    return (
        String(name || "file")
            .replace(/[^\w.\- ()[\]]+/g, "_")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120) || "file"
    );
}

function assertSafeStorageKey(carrierId: string, storageKey: string, root: string): string {
    const resolved = path.resolve(path.join(root, carrierId, storageKey));
    const carrierRoot = path.resolve(path.join(root, carrierId));
    if (!resolved.startsWith(carrierRoot + path.sep) && resolved !== carrierRoot) {
        throw Object.assign(new Error("Invalid storage key"), { status: 400 });
    }
    return resolved;
}

/** Absolute path to a stored carrier file, checking cwd + legacy roots. */
export function resolveCarrierDocumentAbsolutePath(
    carrierId: string,
    storageKey: string
): string | null {
    const id = String(carrierId || "").trim();
    const key = String(storageKey || "").trim();
    if (!id || !key) return null;
    const roots = [CARRIER_UPLOADS_ROOT, ...LEGACY_CARRIER_UPLOADS_ROOTS];
    const seen = new Set<string>();
    for (const root of roots) {
        let abs: string;
        try {
            abs = assertSafeStorageKey(id, key, root);
        } catch {
            continue;
        }
        if (seen.has(abs)) continue;
        seen.add(abs);
        if (fs.existsSync(abs)) return abs;
    }
    return null;
}

export class CarrierStorageService {
    ensureDir(carrierId: string) {
        const dir = path.join(CARRIER_UPLOADS_ROOT, carrierId);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    assertSafeUpload(input: { originalName: string; mimeType: string; size: number }) {
        if (!input.size || input.size <= 0) {
            throw Object.assign(new Error("Empty file"), { status: 400 });
        }
        if (input.size > MAX_UPLOAD_BYTES) {
            throw Object.assign(new Error("File too large (max 15 MB)"), { status: 400 });
        }
        const ext = path.extname(input.originalName || "").toLowerCase();
        if (BLOCKED_EXT.has(ext)) {
            throw Object.assign(new Error("Executable or script files are not allowed"), { status: 400 });
        }
        const mime = String(input.mimeType || "").toLowerCase().trim();
        if (
            BLOCKED_MIME.has(mime) ||
            BLOCKED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))
        ) {
            throw Object.assign(new Error("Executable or script files are not allowed"), { status: 400 });
        }
    }

    storeFromTemp(input: {
        carrierId: string;
        documentType: string;
        originalName: string;
        mimeType: string;
        tempPath: string;
        version: number;
    }): { storageKey: string; checksum: string; fileSize: number; absolutePath: string } {
        this.assertSafeUpload({
            originalName: input.originalName,
            mimeType: input.mimeType,
            size: fs.statSync(input.tempPath).size,
        });
        const dir = this.ensureDir(input.carrierId);
        const safe = safeFileName(input.originalName);
        const storageKey = `${input.documentType}_v${input.version}_${Date.now()}_${safe}`;
        const absolutePath = path.join(dir, storageKey);
        fs.renameSync(input.tempPath, absolutePath);
        const buf = fs.readFileSync(absolutePath);
        const checksum = crypto.createHash("sha256").update(buf).digest("hex");
        return {
            storageKey,
            checksum,
            fileSize: buf.length,
            absolutePath,
        };
    }

    /**
     * Preferred path for a storage key under the canonical root (for writes / DB).
     * For reads prefer {@link resolveCarrierDocumentAbsolutePath}.
     */
    absolutePath(carrierId: string, storageKey: string): string {
        const found = resolveCarrierDocumentAbsolutePath(carrierId, storageKey);
        if (found) return found;
        return assertSafeStorageKey(carrierId, storageKey, CARRIER_UPLOADS_ROOT);
    }

    /** Best-effort unlink of a stored carrier file across canonical + legacy roots. */
    tryUnlink(carrierId: string, storageKey: string): void {
        const roots = [CARRIER_UPLOADS_ROOT, ...LEGACY_CARRIER_UPLOADS_ROOTS];
        const seen = new Set<string>();
        for (const root of roots) {
            try {
                const absolutePath = assertSafeStorageKey(carrierId, storageKey, root);
                if (seen.has(absolutePath)) continue;
                seen.add(absolutePath);
                if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
            } catch {
                /* ignore invalid key / missing file */
            }
        }
    }
}

export const carrierStorageService = new CarrierStorageService();
