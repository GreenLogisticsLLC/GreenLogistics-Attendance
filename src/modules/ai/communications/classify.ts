import type { ResponseClass } from "./types.js";

export function classifyResponse(text: string | null | undefined): ResponseClass {
    const value = String(text || "").trim();
    if (!value) return "NO_RESPONSE";
    if (/\b(attached|attachment|see attached)\b/i.test(value)) return "DOCUMENT_RECEIVED";
    if (/\b(cannot|can't|unable|won't|will not|do not have|don't have|negative)\b/i.test(value)) {
        return "NEGATIVE_RESPONSE";
    }
    if (/\b(yes(?:,\s*)?we will|we will|we'll|sending|will send|can provide|confirmed|agree)\b/i.test(value)) {
        return "POSITIVE_RESPONSE";
    }
    return "UNCERTAIN";
}

export function extractCommitment(
    text: string | null | undefined,
    now: Date = new Date()
): { subject: string | null; promisedDate: string | null } {
    const value = String(text || "").trim();
    const promise = value.match(
        /\b(?:we\s+will|we'll|i\s+will|i'll|will\s+send|will\s+provide|promise(?:\s+to)?|committed?\s+to)\s+([^.!?\n]{1,120})/i
    );
    if (!promise) return { subject: null, promisedDate: null };

    let subject = promise[1].trim().replace(/\b(?:by|on)\s+.+$/i, "").trim() || null;
    if (subject && subject.length > 100) subject = subject.slice(0, 100);
    let promisedDate: string | null = null;

    if (/\btomorrow\b/i.test(value)) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        promisedDate = tomorrow.toISOString().slice(0, 10);
    } else {
        const iso = value.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
        if (iso) promisedDate = iso[1];
        else {
            const us = value.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\b/);
            if (us) {
                promisedDate = `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
            }
        }
    }
    return { subject, promisedDate };
}

export function detectDocumentTypesInText(text: string | null | undefined): string[] {
    const value = String(text || "");
    const checks: Array<[string, RegExp]> = [
        ["COI", /\bCOI\b|certificate of insurance/i],
        ["NOA", /\bNOA\b|notice of assignment/i],
        ["W9", /\bW-?9\b/i],
        ["POD", /\bPOD\b|proof of delivery/i],
        ["BOL", /\bBOL\b|bill of lading/i],
        ["AGREEMENT", /\bagreement\b|broker.carrier agreement/i],
        ["MC_AUTHORITY", /\bMC[\s_-]*AUTHORITY\b|motor carrier authority/i],
        ["INSURANCE", /\binsurance\b/i],
    ];
    return checks.filter(([, pattern]) => pattern.test(value)).map(([type]) => type);
}
