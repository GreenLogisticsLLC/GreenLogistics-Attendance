/**
 * Accounting carrier payout methods — distinct from Rate Confirmation /
 * carrier-profile payment option codes (STANDARD / QUICK_3 / FACTORING / …).
 */

export const ACCOUNTING_CARRIER_PAYMENT_METHODS = [
    { id: "ZELLE", label: "Zelle" },
    { id: "PAYPAL", label: "PayPal" },
    { id: "VENMO", label: "Venmo" },
    { id: "STRIPE", label: "Stripe" },
    { id: "FACTORING", label: "Factoring Company" },
    { id: "ACH", label: "ACH" },
] as const;

export type AccountingCarrierPaymentMethodId =
    (typeof ACCOUNTING_CARRIER_PAYMENT_METHODS)[number]["id"];

const BY_ID = new Map(
    ACCOUNTING_CARRIER_PAYMENT_METHODS.map((row) => [row.id, row] as const)
);

export function accountingCarrierPaymentMethodLabel(
    code: string | null | undefined
): string | null {
    const id = normalizeAccountingCarrierPaymentMethod(code);
    if (!id) return code ? String(code) : null;
    return BY_ID.get(id)?.label || id;
}

/**
 * Normalize Accounting / UI / RC / profile values into an Accounting method id.
 * Returns null when the value is empty or not one of the allowed methods.
 */
export function normalizeAccountingCarrierPaymentMethod(
    value: unknown
): AccountingCarrierPaymentMethodId | null {
    const raw = String(value || "")
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, "_");
    if (!raw) return null;
    if (raw === "FACTORING_COMPANY" || raw === "FACTORINGCOMPANY") return "FACTORING";
    if (raw === "FACTORING") return "FACTORING";
    if (BY_ID.has(raw as AccountingCarrierPaymentMethodId)) {
        return raw as AccountingCarrierPaymentMethodId;
    }
    // Loose match against labels ("Factoring company", "PayPal", …).
    const compact = raw.replace(/_/g, "");
    for (const row of ACCOUNTING_CARRIER_PAYMENT_METHODS) {
        const label = row.label.toUpperCase().replace(/[\s-]+/g, "_");
        if (label === raw || label.replace(/_/g, "") === compact) return row.id;
    }
    return null;
}

/** Calendar date at UTC noon so local date pickers don't shift day across zones. */
export function parseAccountingPaymentDate(value: unknown): Date | null {
    if (value == null || value === "") return null;
    if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value : null;
    }
    const raw = String(value).trim();
    if (!raw) return null;
    // YYYY-MM-DD from <input type="date">
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (m) {
        const y = Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
        return Number.isFinite(dt.getTime()) ? dt : null;
    }
    const dt = new Date(raw);
    return Number.isFinite(dt.getTime()) ? dt : null;
}

export function formatAccountingPaymentDateInput(
    value: Date | string | null | undefined
): string {
    if (!value) return "";
    const d = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(d.getTime())) return "";
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${mo}-${day}`;
}

/**
 * Effective date for PAID KPI reporting: Accounting payment date when set,
 * otherwise the mark-paid timestamp. Never invents a date for unpaid loads.
 */
export function effectiveCarrierPaidReportingDate(input: {
    carrierPaidAt?: Date | string | null;
    accountingCarrierPaymentDate?: Date | string | null;
}): Date | null {
    if (!input.carrierPaidAt) return null;
    const preferred = parseAccountingPaymentDate(input.accountingCarrierPaymentDate);
    if (preferred) return preferred;
    const marked = parseAccountingPaymentDate(input.carrierPaidAt);
    return marked;
}
