import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { pdfjsOpenOptions } from "./pdf-enrich.js";

const execFileAsync = promisify(execFile);

export type W9Marks = {
    name: string | null;
    ein: string | null;
    signed: boolean;
    signatureDate: string | null;
};

type TextItem = { str: string; x: number; y: number };

const NAME_STOP =
    /request for taxpayer|department of the treasury|internal revenue|business name|social security|employer identification|signature of|u\.s\. person|part i\b|part ii\b|certification|give form|print or type|see specific/i;

function filledName(raw: string | null | undefined): string | null {
    const value = String(raw || "").replace(/\s+/g, " ").trim();
    if (value.length < 3 || NAME_STOP.test(value)) return null;
    if (!/[A-Za-z]/.test(value)) return null;
    return value;
}

function einDigits(raw: string): string | null {
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 9) return null;
    return `${digits.slice(0, 2)}-${digits.slice(2, 9)}`;
}

/** Read the three circled W-9 marks from a text layer: line 1 name, EIN, signature. */
export function w9MarksFromItems(
    items: TextItem[],
    signatureImages: Array<{ x: number; y: number; w: number; h: number }>
): W9Marks {
    const line1 = items
        .filter((item) => item.str.trim() === "1" && item.x < 90)
        .sort((a, b) => b.y - a.y)[0];
    const line2 = items
        .filter((item) => item.str.trim() === "2" && item.x < 90 && (!line1 || item.y < line1.y))
        .sort((a, b) => b.y - a.y)[0];
    let name: string | null = null;
    if (line1) {
        const band = items.filter(
            (item) =>
                item.y < line1.y - 4 &&
                (!line2 || item.y > line2.y + 4) &&
                item.x < 400 &&
                item.str.trim().length > 2
        );
        name = filledName(band.sort((a, b) => b.y - a.y || a.x - b.x).map((item) => item.str).join(" "));
    }
    if (!name) {
        name = filledName(
            items.find((item) => /\b(LLC|INC|CORP|LP|LLP)\b/i.test(item.str) && !NAME_STOP.test(item.str))?.str
        );
    }

    const einLabel = items
        .filter((item) => /^employer identification number$/i.test(item.str.trim()))
        .sort((a, b) => b.x - a.x)[0];
    let ein: string | null = null;
    if (einLabel) {
        const digits = items
            .filter(
                (item) =>
                    /^\d$/.test(item.str.trim()) &&
                    item.x > einLabel.x - 10 &&
                    Math.abs(item.y - (einLabel.y - 20)) < 14
            )
            .sort((a, b) => a.x - b.x)
            .map((item) => item.str.trim())
            .join("");
        ein = einDigits(digits);
    }

    const signLabel = items.find((item) => /signature of/i.test(item.str));
    const dateLabel = items.find(
        (item) => /^date\b/i.test(item.str.trim()) && (!signLabel || Math.abs(item.y - signLabel.y) < 20)
    );
    let signatureDate: string | null = null;
    if (dateLabel) {
        const raw = items
            .filter((item) => item.x > dateLabel.x + 8 && Math.abs(item.y - dateLabel.y) < 8)
            .sort((a, b) => a.x - b.x)
            .map((item) => item.str)
            .join("");
        const match = raw.match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{2,4})/);
        if (match) {
            const year = match[3].length === 2 ? `20${match[3]}` : match[3];
            signatureDate = `${match[1].padStart(2, "0")}/${match[2].padStart(2, "0")}/${year}`;
        }
    }

    const signedByImage = signatureImages.some((image) => {
        if (!signLabel) return false;
        const pageWide = image.w > 400 && image.h > 400;
        if (pageWide) return false;
        return image.x < (dateLabel?.x || 400) && Math.abs(image.y - signLabel.y) < 50;
    });
    const signedByText = Boolean(
        signLabel &&
            items.some(
                (item) =>
                    item.x > signLabel.x + 40 &&
                    (!dateLabel || item.x < dateLabel.x - 8) &&
                    Math.abs(item.y - signLabel.y) < 16 &&
                    /[A-Za-z]{3,}/.test(item.str)
            )
    );

    return {
        name,
        ein,
        signed: signedByImage || signedByText,
        signatureDate,
    };
}

export function w9MarksFromText(text: string): W9Marks {
    const flat = String(text || "");
    const name =
        filledName(flat.match(/(?:^|\n)\s*1[^\n]{0,40}\n\s*([^\n]{3,80})/i)?.[1]) ||
        filledName(flat.match(/\b([A-Z][A-Za-z0-9&.'’ -]{2,60}\s(?:LLC|INC|CORP|LP|LLP))\b/)?.[1]);
    const einHits = [...flat.matchAll(/employer identification number([\s\S]{0,180})/gi)];
    const einWindow = einHits.length ? einHits[einHits.length - 1][1] : "";
    const windowDigits = einWindow.replace(/\D/g, "");
    const ein =
        (windowDigits.length >= 9 ? einDigits(windowDigits) : windowDigits.length >= 8 ? windowDigits : null) ||
        einDigits(flat.match(/\b(\d{2})\s*[-–]\s*(\d{7})\b/)?.[0] || "");
    const signatureDate = flat.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/)?.[1] || null;
    const between = flat.match(/signature of\s+u\.?s\.?\s*person([\s\S]{0,120}?)date/i)?.[1] || "";
    const signerLetters = between.replace(/sign\s+here/gi, "").replace(/\bdate\b/gi, "").replace(/[^A-Za-z]/g, "");
    const signed =
        signerLetters.length >= 4 ||
        /signature of\s+u\.?s\.?\s*person\s+(?!date\b)[A-Za-z]{3,}/i.test(flat);
    return { name, ein, signed, signatureDate };
}

type PdfImage = { x: number; y: number; w: number; h: number };

function multiply(a: number[], b: number[]): number[] {
    return [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ];
}

export async function readW9CircledMarks(filePath: string): Promise<W9Marks> {
    const empty: W9Marks = { name: null, ein: null, signed: false, signatureDate: null };
    if (!filePath || !fs.existsSync(filePath)) return empty;
    let positioned = empty;
    try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const data = new Uint8Array(fs.readFileSync(filePath));
        const doc = await pdfjs.getDocument(pdfjsOpenOptions(data)).promise;
        const page = await doc.getPage(1);
        const content = await page.getTextContent();
        const items: TextItem[] = [];
        for (const item of content.items) {
            if (!("str" in item) || !item.str.trim()) continue;
            items.push({
                str: item.str,
                x: item.transform[4],
                y: item.transform[5],
            });
        }
        const images: PdfImage[] = [];
        if (items.length > 40) {
            const ops = await page.getOperatorList();
            const OPS = pdfjs.OPS;
            let ctm = [1, 0, 0, 1, 0, 0];
            const stack: number[][] = [];
            for (let i = 0; i < ops.fnArray.length; i++) {
                const fn = ops.fnArray[i];
                const args = ops.argsArray[i] as number[];
                if (fn === OPS.save) stack.push(ctm.slice());
                else if (fn === OPS.restore) ctm = stack.pop() || ctm;
                else if (fn === OPS.transform) ctm = multiply(ctm, args);
                else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
                    images.push({ x: ctm[4], y: ctm[5], w: Math.abs(ctm[0]), h: Math.abs(ctm[3]) });
                }
            }
        }
        positioned = w9MarksFromItems(items, images);
    } catch (err) {
        console.warn("[doc-ai] W-9 layout read failed:", err instanceof Error ? err.message : err);
    }
    if (positioned.name && positioned.ein && positioned.signed) return positioned;
    const fromOcr = await ocrScanMarks(filePath);
    return {
        name: positioned.name || fromOcr.name,
        ein: positioned.ein || fromOcr.ein,
        signed: positioned.signed || fromOcr.signed,
        signatureDate: positioned.signatureDate || fromOcr.signatureDate,
    };
}

function w9MarksFromOcrTsv(tsv: string): W9Marks {
    const words: Array<{ x: number; y: number; text: string }> = [];
    for (const line of tsv.split("\n").slice(1)) {
        const parts = line.split("\t");
        if (parts.length < 12 || parts[0] !== "5") continue;
        const text = parts[11].trim();
        if (!text) continue;
        words.push({ x: Number(parts[6]) || 0, y: Number(parts[7]) || 0, text });
    }
    const company = words.find((word) => word.y < 900 && /\b(LLC|INC|CORP)\b/i.test(word.text));
    let name = company?.text || null;
    if (company) {
        const prev = words
            .filter((word) => Math.abs(word.y - company.y) < 18 && word.x < company.x && /[A-Za-z]{3,}/.test(word.text))
            .sort((a, b) => b.x - a.x)[0];
        if (prev) name = `${prev.text} ${company.text}`;
    }
    const employers = words.filter((word) => /^employer$/i.test(word.text));
    const employer = employers[employers.length - 1];
    let ein: string | null = null;
    if (employer) {
        const digits = words
            .filter((word) => word.y > employer.y && word.y < employer.y + 80 && word.x > employer.x - 40)
            .map((word) => word.text.replace(/\D/g, ""))
            .join("");
        if (digits.length >= 8) ein = einDigits(digits) || digits.slice(0, 9);
    }
    const sign = words.find((word) => /^sign$/i.test(word.text) && word.y > 800);
    const signed = Boolean(
        sign &&
            words.some(
                (word) =>
                    Math.abs(word.y - sign.y) < 40 &&
                    word.x > sign.x + 80 &&
                    /[A-Za-z]{4,}/.test(word.text) &&
                    !/^(signature|person|here|date|sign)$/i.test(word.text)
            )
    );
    return { name: filledName(name), ein, signed, signatureDate: null };
}

async function ocrTsv(png: Buffer): Promise<string> {
    const tmp = path.join(os.tmpdir(), `w9-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
    fs.writeFileSync(tmp, png);
    try {
        const { stdout } = await execFileAsync("tesseract", [tmp, "stdout", "tsv", "--psm", "6"], {
            maxBuffer: 12_000_000,
        });
        if (stdout && stdout.includes("\t")) return stdout;
    } catch {
        /* tesseract CLI is optional; fall through to the bundled engine */
    } finally {
        fs.rmSync(tmp, { force: true });
    }
    const { default: Tesseract } = await import("tesseract.js");
    const worker = await Tesseract.createWorker("eng");
    try {
        const result = await worker.recognize(png, {}, { tsv: true });
        return String(result.data?.tsv || "");
    } finally {
        await worker.terminate();
    }
}

async function ocrScanMarks(filePath: string): Promise<W9Marks> {
    const empty: W9Marks = { name: null, ein: null, signed: false, signatureDate: null };
    try {
        const { renderPdfFirstEmbeddedImagePng } = await import("./pdf-enrich.js");
        const png = await renderPdfFirstEmbeddedImagePng(filePath);
        if (!png) return empty;
        const tsv = await ocrTsv(png);
        return w9MarksFromOcrTsv(tsv);
    } catch (err) {
        console.warn("[doc-ai] W-9 scan OCR failed:", err instanceof Error ? err.message : err);
        return empty;
    }
}
