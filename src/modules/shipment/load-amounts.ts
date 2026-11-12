/** Shared money parsers for Load books ↔ Rate Con / Invoice document content. */

export function parseMoneyValue(v: unknown): number | null {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : null;
}

/** Prefer invoice total (what customer pays), not hourly rate. */
export function customerAmountFromInvoiceContent(
    content: Record<string, unknown> | null | undefined
): number | null {
    if (!content) return null;
    return (
        parseMoneyValue(content.totalAmountDue) ??
        parseMoneyValue(content.invoiceLineTotal) ??
        parseMoneyValue(content.invoiceSubtotal) ??
        parseMoneyValue(content.customerRate) ??
        null
    );
}

/** Flat Rate on Rate Confirmation → Carrier price (отдали) on the Load. */
export function carrierAmountFromRateConContent(
    content: Record<string, unknown> | null | undefined
): number | null {
    if (!content) return null;
    return parseMoneyValue(content.flatRate) ?? parseMoneyValue(content.carrierRate) ?? null;
}
