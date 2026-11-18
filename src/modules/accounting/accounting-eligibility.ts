/**
 * Which loads belong in Accounting queues.
 *
 * Accept Green auto-allocates a GL# before the broker saves customer rate.
 * Incomplete / resurrected cards (custRate missing, only carrier rate) pollute
 * Documents review and break profit (0 − carrierRate).
 */

export type AccountingEligibilityInput = {
    status?: string | null;
    customerRate?: number | null;
    price?: number | null;
    invoiceTotalUsd?: number | null;
    invoiceNumber?: string | null;
    invoiceSubtotalUsd?: number | null;
    customerPaidAt?: Date | string | null;
    carrierPaidAt?: Date | string | null;
    accountingReadyForBilling?: boolean | null;
    accountingReadyForCarrierPayment?: boolean | null;
};

function money(n: unknown): number | null {
    if (n == null || n === "") return null;
    const v = Number(n);
    return Number.isFinite(v) ? v : null;
}

/** Positive customer-side amount from books / invoice. */
export function customerAmountUsd(row: AccountingEligibilityInput): number | null {
    const candidates = [
        money(row.customerRate),
        money(row.price),
        money(row.invoiceTotalUsd),
        money(row.invoiceSubtotalUsd),
    ];
    for (const n of candidates) {
        if (n != null && n > 0) return n;
    }
    return null;
}

/**
 * True when Accounting should show this load in active queues (not Archive).
 * Voided / closed-paid are handled by callers; this blocks empty-rate ghosts.
 */
export function isAccountingWorkEligible(row: AccountingEligibilityInput): boolean {
    const status = String(row.status || "").toUpperCase();
    if (status === "VOIDED") return false;

    if (row.customerPaidAt || row.carrierPaidAt) return true;
    if (row.accountingReadyForBilling || row.accountingReadyForCarrierPayment) return true;
    if (row.invoiceNumber) return true;
    if (customerAmountUsd(row) != null) return true;

    return false;
}
