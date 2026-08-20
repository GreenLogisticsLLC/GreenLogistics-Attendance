/**
 * Safe carrier MC query normalization for Phase 1 AI findCarriers.
 * Digits-only identity — not a fuzzy name search.
 */
export function extractMcDigits(input: string): string | null {
    const s = String(input || "").trim();
    if (!s) return null;
    const m =
        s.match(/^(?:MC[#\s-]*)?([0-9]{4,10})$/i) ||
        s.match(/\bMC[#\s-]*([0-9]{4,10})\b/i);
    return m ? m[1] : null;
}

/** Compact variants that may appear in mc_number (narrow, not fuzzy). */
export function mcSearchVariants(input: string): string[] {
    const raw = String(input || "").trim();
    const digits = extractMcDigits(raw);
    const out: string[] = [];
    const add = (v: string) => {
        if (v && !out.includes(v)) out.push(v);
    };
    if (raw) add(raw);
    if (digits) {
        add(digits);
        add(`MC${digits}`);
        add(`MC-${digits}`);
        add(`MC ${digits}`);
        add(`mc${digits}`);
    }
    return out;
}
