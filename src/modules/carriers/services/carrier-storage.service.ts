import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { ALLOWED_UPLOAD_MIME, MAX_UPLOAD_BYTES } from "../constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CARRIER_UPLOADS_ROOT = path.join(__dirname, "..", "..", "..", "uploads", "carriers");

const BLOCKED_EXT = new Set([
    ".exe",
    ".bat",
    ".cmd",
    ".com",
    ".msi",
    ".js",
    ".mjs",
    ".vbs",
    ".ps1",
    ".sh",
    ".dll",
    ".scr",
    ".jar",
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
        const mime = String(input.mimeType || "").toLowerCase();
        if (mime && !ALLOWED_UPLOAD_MIME.has(mime) && !mime.startsWith("image/")) {
            throw Object.assign(new Error("File type not allowed. Upload PDF or image."), { status: 400 });
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

    absolutePath(carrierId: string, storageKey: string): string {
        const resolved = path.resolve(path.join(CARRIER_UPLOADS_ROOT, carrierId, storageKey));
        const root = path.resolve(path.join(CARRIER_UPLOADS_ROOT, carrierId));
        if (!resolved.startsWith(root + path.sep) && resolved !== root) {
            throw Object.assign(new Error("Invalid storage key"), { status: 400 });
        }
        return resolved;
    }
}

export const carrierStorageService = new CarrierStorageService();
