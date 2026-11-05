import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { pdfjsOpenOptions, renderPdfFirstEmbeddedImagePng } from "./pdf-enrich.js";

const execFileAsync = promisify(execFile);

export type McCertificate = {
    mc: string | null;
    dot: string | null;
    name: string | null;
};

function digits(raw: string | null | undefined): string | null {
    const n = String(raw || "").replace(/\D/g, "").replace(/^0+/, "");
    return n.length >= 4 ? n : null;
}

function isCityLine(line: string): boolean {
    return /^[A-Za-z .'-]+,\s*[A-Z]{2}\.?$/.test(line.trim());
}

/** Only the certificate box: MC number, U.S. DOT number, and the carrier name under them. */
export function mcCertificateFromText(text: string): McCertificate {
    const lines = String(text || "")
        .split(/\n/)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean);
    const start = lines.findIndex((line) => /^CERTIFICATE$/i.test(line));
    const window = start >= 0 ? lines.slice(start, start + 7) : lines.slice(0, 10);
    const blob = window.join("\n");

    let mc: string | null = null;
    const labeled = blob.match(/\bMC\s*[-#]?\s*([0-9]{4,})/i);
    if (labeled) mc = digits(labeled[1]);
    if (!mc) {
        const docket = blob.match(/\b\d{2}\s*[-–]\s*([0-9]{5,})\b/);
        if (docket) mc = digits(docket[1]);
    }
    if (!mc) {
        const bare = blob.match(/\b0*([1-9][0-9]{4,7})\b/);
        const dotDigits = blob.match(/DOT\s*No\.?\s*([0-9]{4,})/i)?.[1];
        if (bare && bare[1] !== digits(dotDigits)) mc = digits(bare[1]);
    }

    const dot = digits(
        blob.match(/DOT\s*(?:No|Na|Number|#)?\.?\s*([0-9]{4,})/i)?.[1] || null
    );

    const name =
        window.find((line) => {
            if (/^CERTIFICATE$/i.test(line)) return false;
            if (/\bMC\s*[-#]?\s*\d/i.test(line)) return false;
            if (/\bDOT\b/i.test(line)) return false;
            if (isCityLine(line)) return false;
            if (/^this certificate/i.test(line)) return false;
            return /[A-Za-z]{3,}/.test(line) && line.length <= 80;
        }) || null;

    return { mc, dot, name };
}

export async function readMcCertificate(filePath: string): Promise<McCertificate> {
    const empty: McCertificate = { mc: null, dot: null, name: null };
    if (!filePath || !fs.existsSync(filePath)) return empty;
    let fromText = empty;
    try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const data = new Uint8Array(fs.readFileSync(filePath));
        const doc = await pdfjs.getDocument(pdfjsOpenOptions(data)).promise;
        const page = await doc.getPage(1);
        const content = await page.getTextContent();
        const rows = new Map<number, Array<{ x: number; str: string }>>();
        for (const item of content.items) {
            if (!("str" in item) || !item.str.trim()) continue;
            const y = Math.round(item.transform[5]);
            const row = rows.get(y) || [];
            row.push({ x: item.transform[4], str: item.str });
            rows.set(y, row);
        }
        const lines = [...rows.keys()]
            .sort((a, b) => b - a)
            .map((y) =>
                (rows.get(y) || [])
                    .sort((a, b) => a.x - b.x)
                    .map((part) => part.str)
                    .join(" ")
            );
        fromText = mcCertificateFromText(lines.join("\n"));
    } catch (err) {
        console.warn("[doc-ai] MC certificate layout failed:", err instanceof Error ? err.message : err);
    }
    if (fromText.mc && fromText.dot && fromText.name) return fromText;
    const ocr = await ocrCertificate(filePath);
    return {
        mc: fromText.mc || ocr.mc,
        dot: fromText.dot || ocr.dot,
        name: fromText.name || ocr.name,
    };
}

async function ocrCertificate(filePath: string): Promise<McCertificate> {
    const empty: McCertificate = { mc: null, dot: null, name: null };
    try {
        const png = await renderPdfFirstEmbeddedImagePng(filePath);
        if (!png) return empty;
        const tmp = path.join(os.tmpdir(), `mc-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
        fs.writeFileSync(tmp, png);
        try {
            const { stdout } = await execFileAsync("tesseract", [tmp, "stdout", "--psm", "6"], {
                maxBuffer: 8_000_000,
            });
            return mcCertificateFromText(String(stdout || ""));
        } finally {
            fs.rmSync(tmp, { force: true });
        }
    } catch {
        return empty;
    }
}
