import fs from "fs";
import path from "path";

export type TextExtractResult = {
    text: string;
    pageCount: number | null;
    method: "pdf-parse" | "utf8" | "empty";
    adequate: boolean;
};

/**
 * Text-first extraction. Vision/OCR is a later step when inadequate.
 */
export async function extractDocumentText(filePath: string): Promise<TextExtractResult> {
    const ext = path.extname(filePath).toLowerCase();
    if (!fs.existsSync(filePath)) {
        return { text: "", pageCount: null, method: "empty", adequate: false };
    }

    if (ext === ".pdf") {
        try {
            const buf = fs.readFileSync(filePath);
            const pdfParse = (await import("pdf-parse")).default;
            const data = await pdfParse(buf);
            const text = String(data.text || "").trim();
            return {
                text,
                pageCount: data.numpages ?? null,
                method: "pdf-parse",
                adequate: text.length >= 80,
            };
        } catch (err) {
            console.warn("[doc-ai] pdf text extract failed:", err instanceof Error ? err.message : err);
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
