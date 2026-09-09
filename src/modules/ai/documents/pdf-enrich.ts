import fs from "fs";
import { PNG } from "pngjs";
import { PDFDocument } from "pdf-lib";

/**
 * Enrich PDF text for Document AI:
 * 1) AcroForm field values (filled W-9 EIN boxes are not in the text layer)
 * 2) OCR of embedded page images when the text layer is empty/scarce (scanned NOA)
 */

export async function extractPdfAcroFormSupplement(filePath: string): Promise<string> {
    try {
        const bytes = fs.readFileSync(filePath);
        const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const form = pdf.getForm();
        const lines: string[] = [];
        const values: string[] = [];
        let einLeft: string | null = null;
        let einRight: string | null = null;

        for (const field of form.getFields()) {
            const name = field.getName();
            let val = "";
            try {
                const anyField = field as {
                    getText?: () => string;
                    isChecked?: () => boolean;
                    getSelected?: () => string | string[];
                };
                if (typeof anyField.getText === "function") {
                    val = String(anyField.getText() || "").trim();
                } else if (typeof anyField.isChecked === "function" && anyField.isChecked()) {
                    val = "checked";
                } else if (typeof anyField.getSelected === "function") {
                    const sel = anyField.getSelected();
                    val = Array.isArray(sel) ? sel.join(" ") : String(sel || "");
                }
            } catch {
                val = "";
            }
            if (!val) continue;
            lines.push(`${name}: ${val}`);
            values.push(val);
            // IRS W-9 Part I EIN split boxes: f1_14 (XX) + f1_15 (XXXXXXX)
            if (/\.f1_14\[/.test(name) || /f1_14/i.test(name)) einLeft = val.replace(/\D/g, "");
            if (/\.f1_15\[/.test(name) || /f1_15/i.test(name)) einRight = val.replace(/\D/g, "");
        }

        if (einLeft && einRight && einLeft.length >= 2 && einRight.length >= 7) {
            const ein = `${einLeft.slice(0, 2)}-${einRight.slice(0, 7)}`;
            lines.push(`Employer identification number ${ein}`);
            lines.push(`EIN: ${ein}`);
        } else {
            // Fallback: stitch any 2+7 digit pair already present as separate values
            const two = values.map((v) => v.replace(/\D/g, "")).find((d) => d.length === 2);
            const seven = values.map((v) => v.replace(/\D/g, "")).find((d) => d.length === 7);
            if (two && seven) {
                const ein = `${two}-${seven}`;
                lines.push(`Employer identification number ${ein}`);
                lines.push(`EIN: ${ein}`);
            }
        }

        if (!lines.length) return "";
        return `\n\n[AcroForm]\n${lines.join("\n")}\n`;
    } catch (err) {
        console.warn("[doc-ai] acroform extract failed:", err instanceof Error ? err.message : err);
        return "";
    }
}

export async function ocrPdfFirstPageImage(filePath: string): Promise<string> {
    try {
        const png = await renderPdfFirstEmbeddedImagePng(filePath);
        if (!png || png.length < 100) return "";
        const { default: Tesseract } = await import("tesseract.js");
        const result = await Tesseract.recognize(png, "eng", {
            logger: () => undefined,
        });
        return String(result.data?.text || "").trim();
    } catch (err) {
        console.warn("[doc-ai] pdf OCR failed:", err instanceof Error ? err.message : err);
        return "";
    }
}

/** PNG bytes of the first embedded full-page image (scanned NOA/W-9 style PDFs). */
export async function renderPdfFirstEmbeddedImagePng(filePath: string): Promise<Buffer | null> {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(fs.readFileSync(filePath));
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
    const page = await doc.getPage(1);
    const ops = await page.getOperatorList();
    const OPS = pdfjs.OPS;

    let imageName: string | null = null;
    for (let i = 0; i < ops.fnArray.length; i++) {
        if (
            ops.fnArray[i] === OPS.paintImageXObject ||
            ops.fnArray[i] === OPS.paintImageXObjectRepeat
        ) {
            imageName = String(ops.argsArray[i][0] || "");
            break;
        }
    }
    if (!imageName) return null;

    const img = await new Promise<{
        width: number;
        height: number;
        data: Uint8ClampedArray | Uint8Array;
    } | null>((resolve) => {
        try {
            page.objs.get(imageName!, (v: unknown) => {
                resolve((v as { width: number; height: number; data: Uint8ClampedArray }) || null);
            });
        } catch {
            resolve(null);
        }
    });
    if (!img?.data || !img.width || !img.height) return null;

    // Downscale large scans for faster OCR (keep legibility for titles / EIN / MC).
    const maxW = 1200;
    const scale = img.width > maxW ? maxW / img.width : 1;
    const tw = Math.max(1, Math.round(img.width * scale));
    const th = Math.max(1, Math.round(img.height * scale));
    const png = new PNG({ width: tw, height: th });
    const src = img.data;
    const channels = Math.round(src.length / (img.width * img.height)) || 3;

    for (let y = 0; y < th; y++) {
        const sy = Math.min(img.height - 1, Math.floor(y / scale));
        for (let x = 0; x < tw; x++) {
            const sx = Math.min(img.width - 1, Math.floor(x / scale));
            const si = (sy * img.width + sx) * channels;
            const di = (y * tw + x) << 2;
            png.data[di] = src[si] ?? 0;
            png.data[di + 1] = src[si + Math.min(1, channels - 1)] ?? 0;
            png.data[di + 2] = src[si + Math.min(2, channels - 1)] ?? 0;
            png.data[di + 3] = 255;
        }
    }

    return PNG.sync.write(png);
}
