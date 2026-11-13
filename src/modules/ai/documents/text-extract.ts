import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { extractPdfAcroFormSupplement, ocrPdfFirstPageImage } from "./pdf-enrich.js";
import { assertValidPdfOrThrow } from "./pdf-validate.js";
import { isPermanentInvalidPdfError, runtimeLog } from "../../../utils/runtime-log.js";

export type TextExtractResult = {
    text: string;
    pageCount: number | null;
    method: "pdf-parse" | "pdf-parse+acroform" | "pdf-ocr" | "utf8" | "empty";
    adequate: boolean;
};

const require = createRequire(import.meta.url);

/**
 * Text-first extraction, then AcroForm (filled W-9), then OCR for scanned PDFs.
 *
 * NOTE: pdf-parse's package root index.js executes a debug harness that
 * crashes without its test PDF. Always load lib/pdf-parse.js directly.
 */
export async function extractDocumentText(filePath: string): Promise<TextExtractResult> {
    const ext = path.extname(filePath).toLowerCase();
    if (!fs.existsSync(filePath)) {
        return { text: "", pageCount: null, method: "empty", adequate: false };
    }

    if (ext === ".pdf") {
        // Structural gate before pdf-parse / OCR — permanent malformed PDFs throw.
        assertValidPdfOrThrow(filePath);
        try {
            const buf = fs.readFileSync(filePath);
            const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
                b: Buffer
            ) => Promise<{ text: string; numpages?: number }>;
            const data = await pdfParse(buf);
            let text = String(data.text || "").trim();
            const pageCount = data.numpages ?? null;
            let method: TextExtractResult["method"] = "pdf-parse";

            // Filled IRS W-9 values live in AcroForm, not the printable text layer.
            const acro = await extractPdfAcroFormSupplement(filePath);
            if (acro) {
                text = `${text}${acro}`.trim();
                method = "pdf-parse+acroform";
            }

            // Scanned NOA / image-only PDFs: OCR the embedded page image.
            if (text.replace(/\s+/g, " ").trim().length < 80) {
                const ocr = await ocrPdfFirstPageImage(filePath);
                if (ocr) {
                    text = `${text}\n${ocr}`.trim();
                    method = "pdf-ocr";
                }
            }

            return {
                text,
                pageCount,
                method,
                adequate: text.length >= 80,
            };
        } catch (err) {
            if (isPermanentInvalidPdfError(err)) {
                throw Object.assign(
                    new Error(err instanceof Error ? err.message : "Invalid PDF structure"),
                    { code: "INVALID_PDF_STRUCTURE", permanent: true, status: 422 }
                );
            }
            runtimeLog("WARNING", {
                module: "doc-ai",
                category: "PDF_EXTRACT_FAILED",
                message: "pdf text extract failed (non-permanent)",
                retryEligible: true,
                detail: err instanceof Error ? err.message : String(err),
            });
            return { text: "", pageCount: null, method: "empty", adequate: false };
        }
    }

    if ([".txt", ".csv"].includes(ext)) {
        const text = fs.readFileSync(filePath, "utf8");
        return { text, pageCount: 1, method: "utf8", adequate: text.trim().length >= 20 };
    }

    // Images: no text layer — inadequate → vision path later
    return { text: "", pageCount: 1, method: "empty", adequate: false };
}
