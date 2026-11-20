/**
 * Independent Customer Billing / Carrier Payments membership.
 *
 * Customer and carrier payment statuses are evaluated separately:
 *   Customer PAID  + Carrier UNPAID → Carrier Payments only
 *   Customer UNPAID + Carrier PAID  → Customer Billing only
 *   Customer UNPAID + Carrier UNPAID → both
 *   Customer PAID  + Carrier PAID   → neither (Archive)
 *
 * Uses confirmed paid timestamps only — never rates or ready flags.
 */

export type PaymentSectionInput = {
    status?: string | null;
    customerPaidAt?: Date | string | null;
    carrierPaidAt?: Date | string | null;
    /** Precomputed eligibility; when omitted, voided status alone is checked. */
    accountingEligible?: boolean | null;
};

function isPaid(value: Date | string | null | undefined): boolean {
    return Boolean(value);
}

function isVoided(status: string | null | undefined): boolean {
    return String(status || "").toUpperCase() === "VOIDED";
}

/** Customer Billing: customer still owes (independent of carrier). */
export function belongsInCustomerBilling(row: PaymentSectionInput): boolean {
    if (isVoided(row.status)) return false;
    if (row.accountingEligible === false) return false;
    return !isPaid(row.customerPaidAt);
}

/** Carrier Payments: we still owe the carrier (independent of customer). */
export function belongsInCarrierPayments(row: PaymentSectionInput): boolean {
    if (isVoided(row.status)) return false;
    if (row.accountingEligible === false) return false;
    return !isPaid(row.carrierPaidAt);
}
