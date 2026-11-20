import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { MAX_UPLOAD_BYTES } from "../constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Canonical carrier-doc storage under the process working directory.
 * Prefer cwd so `tsx` (src/) and `node dist/` share the same files — and so
 * `tsc` / dist rebuilds do not wipe uploaded packet documents.
 * Legacy roots (src/uploads, dist/uploads, __dirname-relative) are still resolved when reading.
 */
export const CARRIER_UPLOADS_ROOT = path.join(process.cwd(), "uploads", "carriers");

export const LEGACY_CARRIER_UPLOADS_ROOTS = [
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

function allCarrierRoots(): string[] {
    const roots = [CARRIER_UPLOADS_ROOT, ...LEGACY_CARRIER_UPLOADS_ROOTS];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const root of roots) {
        const abs = path.resolve(root);
        if (seen.has(abs)) continue;
        seen.add(abs);
        out.push(abs);
    }
    return out;
}

/** Absolute path to a stored carrier file, checking cwd + legacy roots. */
export function resolveCarrierDocumentAbsolutePath(
    carrierId: string,
    storageKey: string
): string | null {
    const id = String(carrierId || "").trim();
    const key = String(storageKey || "").trim();
    if (!id || !key) return null;
    const seen = new Set<string>();
    for (const root of allCarrierRoots()) {
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

/**
 * When the exact storageKey is gone (dist wipe), try to find the same packet
 * file by type/version/original name/checksum under any carrier upload root.
 */
export function recoverLooseCarrierFile(input: {
    carrierId: string;
    documentType: string;
    version?: number | null;
    originalFilename?: string | null;
    checksum?: string | null;
    storageKey?: string | null;
}): { absolutePath: string; storageKey: string } | null {
    const carrierId = String(input.carrierId || "").trim();
    if (!carrierId) return null;
    const docType = String(input.documentType || "").trim();
    const version = Number(input.version || 0) || 0;
    const original = safeFileName(String(input.originalFilename || ""));
    const wantChecksum = String(input.checksum || "").trim().toLowerCase();
    const prefix = docType ? `${docType}_v${version || 1}_` : "";

    type Cand = { abs: string; key: string; score: number };
    const cands: Cand[] = [];

    for (const root of allCarrierRoots()) {
        const dir = path.join(root, carrierId);
        if (!fs.existsSync(dir)) continue;
        let names: string[] = [];
        try {
            names = fs.readdirSync(dir);
        } catch {
            continue;
        }
        for (const name of names) {
            if (name.startsWith(".")) continue;
            let abs: string;
            try {
                abs = assertSafeStorageKey(carrierId, name, root);
            } catch {
                continue;
            }
            if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
            let score = 0;
            if (input.storageKey && name === input.storageKey) score += 100;
            if (prefix && name.startsWith(prefix)) score += 40;
            else if (docType && name.startsWith(`${docType}_`)) score += 20;
            if (original && original !== "file" && name.includes(original)) score += 25;
            if (wantChecksum) {
                try {
                    const buf = fs.readFileSync(abs);
                    const sum = crypto.createHash("sha256").update(buf).digest("hex");
                    if (sum === wantChecksum) score += 80;
                } catch {
                    /* ignore */
                }
            }
            if (score > 0) cands.push({ abs, key: name, score });
        }
    }

    cands.sort((a, b) => b.score - a.score);
    const best = cands[0];
    if (!best || best.score < 20) return null;

    // Promote into the canonical root under the recovered key (or original key).
    const preferKey = String(input.storageKey || "").trim() || best.key;
    const canonicalDir = path.join(CARRIER_UPLOADS_ROOT, carrierId);
    fs.mkdirSync(canonicalDir, { recursive: true });
    const canonicalAbs = path.join(canonicalDir, preferKey);
    if (path.resolve(best.abs) !== path.resolve(canonicalAbs)) {
        try {
            fs.copyFileSync(best.abs, canonicalAbs);
        } catch (err) {
            console.warn("[carrier-storage] promote recovered file failed:", err);
            return { absolutePath: best.abs, storageKey: best.key };
        }
    }
    return { absolutePath: canonicalAbs, storageKey: preferKey };
}

/**
 * Copy any leftover files from legacy dist/src upload folders into cwd/uploads.
 * Safe to run on every boot — skips files that already exist at the destination.
 */
export function migrateLegacyCarrierUploads(): { scanned: number; copied: number } {
    fs.mkdirSync(CARRIER_UPLOADS_ROOT, { recursive: true });
    let scanned = 0;
    let copied = 0;
    const canonical = path.resolve(CARRIER_UPLOADS_ROOT);
    for (const root of allCarrierRoots()) {
        if (path.resolve(root) === canonical) continue;
        if (!fs.existsSync(root)) continue;
        let carriers: string[] = [];
        try {
            carriers = fs.readdirSync(root);
        } catch {
            continue;
        }
        for (const carrierId of carriers) {
            const srcDir = path.join(root, carrierId);
            let st: fs.Stats;
            try {
                st = fs.statSync(srcDir);
            } catch {
                continue;
            }
            if (!st.isDirectory()) continue;
            let files: string[] = [];
            try {
                files = fs.readdirSync(srcDir);
            } catch {
                continue;
            }
            for (const name of files) {
                if (name.startsWith(".")) continue;
                scanned += 1;
                const src = path.join(srcDir, name);
                const destDir = path.join(CARRIER_UPLOADS_ROOT, carrierId);
                const dest = path.join(destDir, name);
                try {
                    if (!fs.statSync(src).isFile()) continue;
                    if (fs.existsSync(dest)) continue;
                    fs.mkdirSync(destDir, { recursive: true });
                    fs.copyFileSync(src, dest);
                    copied += 1;
                } catch (err) {
                    console.warn("[carrier-storage] migrate copy skipped:", src, err);
                }
            }
        }
    }
    return { scanned, copied };
}

export function carrierDocumentExists(carrierId: string, storageKey: string): boolean {
    return Boolean(resolveCarrierDocumentAbsolutePath(carrierId, storageKey));
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
        // copy+unlink is safer across filesystems than renameSync (temp often /tmp).
        fs.copyFileSync(input.tempPath, absolutePath);
        try {
            fs.unlinkSync(input.tempPath);
        } catch {
            /* temp cleanup best-effort */
        }
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
        const seen = new Set<string>();
        for (const root of allCarrierRoots()) {
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
