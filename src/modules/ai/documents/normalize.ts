/**
 * Deterministic normalization for Document AI (no LLM).
 */

export function digitsOnly(input: string | null | undefined): string {
    return String(input || "").replace(/\D+/g, "");
}

export function normalizeMc(input: string | null | undefined): string | null {
    const d = digitsOnly(input);
    if (!d || d.length < 4) return null;
    return d.replace(/^0+/, "") || d;
}

export function normalizeDot(input: string | null | undefined): string | null {
    const raw = String(input || "").trim();
    const stripped = raw.replace(/^DOT[#\s-]*/i, "");
    const d = digitsOnly(stripped);
    if (!d || d.length < 4) return null;
    return d;
}

export function normalizePhone(input: string | null | undefined): string | null {
    const d = digitsOnly(input);
    if (!d) return null;
    if (d.length === 11 && d.startsWith("1")) return d.slice(1);
    return d;
}

export function normalizeName(input: string | null | undefined): string | null {
    const s = String(input || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return s || null;
}

export function normalizeMoney(input: string | null | undefined): number | null {
    const s = String(input || "").replace(/[^0-9.]/g, "");
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

export function redactTin(input: string | null | undefined): string | null {
    const d = digitsOnly(input);
    if (!d) return null;
    if (d.length <= 4) return `******${d}`;
    return `******${d.slice(-4)}`;
}

export function tinFingerprint(input: string | null | undefined): string | null {
    const d = digitsOnly(input);
    if (!d || d.length < 4) return null;
    // Stable non-reversible token for equality checks (not encryption of plaintext).
    let h = 2166136261;
    for (let i = 0; i < d.length; i++) {
        h ^= d.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return `tin_${(h >>> 0).toString(16)}_${d.slice(-4)}`;
}

export function normalizeLoadNumber(input: string | null | undefined): string | null {
    const s = String(input || "").trim().toUpperCase();
    if (!s) return null;
    return s.replace(/\s+/g, "");
}

export function namesSoftEqual(a: string | null | undefined, b: string | null | undefined): boolean {
    const na = normalizeName(a);
    const nb = normalizeName(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    // Allow containment for DBA vs legal
    return na.includes(nb) || nb.includes(na);
}
