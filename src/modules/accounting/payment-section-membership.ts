/**
 * Customer Billing / Carrier Payments membership.
 *
 * Rules (confirmed with Accounting):
 *   - Customer Billing = VERIFIED loads still waiting for customer payment.
 *     PENDING / Needs Correction stay in Loads for Review — not Billing.
 *   - Carrier Payments = customer already PAID and carrier still UNPAID.
 *   - Customer UNPAID + Carrier PAID → Customer Billing only.
 *   - Customer PAID + Carrier PAID → neither (Archive).
 *
 * Uses doc status + paid timestamps — never rates or ready flags alone.
 */

export type PaymentSectionInput = {
    status?: string | null;
    accountingDocStatus?: string | null;
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

function docStatus(row: PaymentSectionInput): string {
    return String(row.accountingDocStatus || "PENDING").toUpperCase();
}

export function isAccountingDocumentsVerified(row: PaymentSectionInput): boolean {
    const doc = docStatus(row);
    return doc === "VERIFIED" || doc === "APPROVED";
}

/** Customer Billing: VERIFIED + customer still UNPAID (carrier paid or not). */
export function belongsInCustomerBilling(row: PaymentSectionInput): boolean {
    if (isVoided(row.status)) return false;
    if (row.accountingEligible === false) return false;
    if (!isAccountingDocumentsVerified(row)) return false;
    return !isPaid(row.customerPaidAt);
}

/**
 * Carrier Payments: customer already PAID and carrier still UNPAID.
 * Does not show loads that are only waiting on the customer.
 */
export function belongsInCarrierPayments(row: PaymentSectionInput): boolean {
    if (isVoided(row.status)) return false;
    if (row.accountingEligible === false) return false;
    if (!isPaid(row.customerPaidAt)) return false;
    return !isPaid(row.carrierPaidAt);
}
