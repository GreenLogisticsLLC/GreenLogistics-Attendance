/**
 * Customer Billing / Carrier Payments membership.
 *
 * Rules (confirmed with Accounting):
 *   - Customer Billing = VERIFIED loads still waiting for customer payment.
 *     PENDING / Needs Correction stay in Loads for Review — not Billing.
 *   - Carrier Payments = carrier invoice uploaded (CARRIER_INVOICE doc and/or
 *     accountingReadyForCarrierPayment) + carrier still UNPAID.
 *     Customer payment status does NOT gate this queue — AP runs in parallel with AR.
 *   - Customer UNPAID + Carrier PAID → Customer Billing only.
 *   - Customer PAID + Carrier PAID → neither (Archive).
 */

export type PaymentSectionInput = {
    status?: string | null;
    accountingDocStatus?: string | null;
    customerPaidAt?: Date | string | null;
    carrierPaidAt?: Date | string | null;
    accountingReadyForCarrierPayment?: boolean | null;
    /** True when a current CARRIER_INVOICE load document exists. */
    hasCarrierInvoice?: boolean | null;
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

/** Carrier invoice uploaded and/or sent into the Carrier Payments (AP) queue. */
export function hasCarrierInvoiceForAp(row: PaymentSectionInput): boolean {
    return Boolean(row.accountingReadyForCarrierPayment) || Boolean(row.hasCarrierInvoice);
}

/** Customer Billing: VERIFIED + customer still UNPAID (carrier paid or not). */
export function belongsInCustomerBilling(row: PaymentSectionInput): boolean {
    if (isVoided(row.status)) return false;
    if (row.accountingEligible === false) return false;
    if (!isAccountingDocumentsVerified(row)) return false;
    return !isPaid(row.customerPaidAt);
}

/**
 * Carrier Payments: carrier invoice on the load + carrier still unpaid.
 * Does not require customer paid — Accounting pays carriers independently of AR.
 */
export function belongsInCarrierPayments(row: PaymentSectionInput): boolean {
    if (isVoided(row.status)) return false;
    if (row.accountingEligible === false) return false;
    if (!hasCarrierInvoiceForAp(row)) return false;
    return !isPaid(row.carrierPaidAt);
}
