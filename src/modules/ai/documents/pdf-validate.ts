import fs from "fs";

export type PdfValidationResult =
    | { ok: true; byteLength: number }
    | { ok: false; reason: string; permanent: true };

/**
 * Cheap structural PDF checks before pdf-parse / pdf.js / vision.
 * Does not modify the file. Permanent failures should not be retried forever.
 */
export function validatePdfFile(filePath: string): PdfValidationResult {
    if (!fs.existsSync(filePath)) {
        return { ok: false, reason: "PDF file missing on disk", permanent: true };
    }
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size <= 0) {
        return { ok: false, reason: "PDF file is empty", permanent: true };
    }
    if (st.size < 8) {
        return { ok: false, reason: "PDF file is truncated", permanent: true };
    }

    const fd = fs.openSync(filePath, "r");
    try {
        const header = Buffer.alloc(8);
        fs.readSync(fd, header, 0, 8, 0);
        const head = header.toString("utf8");
        if (!head.startsWith("%PDF-")) {
            return {
                ok: false,
                reason: "PDF header missing (%PDF-) — not a valid PDF",
                permanent: true,
            };
        }

        // Look for an EOF marker near the end (common for truncated uploads).
        const tailSize = Math.min(2048, st.size);
        const tail = Buffer.alloc(tailSize);
        fs.readSync(fd, tail, 0, tailSize, st.size - tailSize);
        if (!/%%EOF/i.test(tail.toString("latin1"))) {
            return {
                ok: false,
                reason: "PDF missing %%EOF — incomplete or malformed PDF",
                permanent: true,
            };
        }
        return { ok: true, byteLength: st.size };
    } finally {
        fs.closeSync(fd);
    }
}

export function assertValidPdfOrThrow(filePath: string): void {
    const result = validatePdfFile(filePath);
    if (!result.ok) {
        throw Object.assign(new Error(result.reason), {
            code: "INVALID_PDF_STRUCTURE",
            permanent: true,
            status: 422,
        });
    }
}
