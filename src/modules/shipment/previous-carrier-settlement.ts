/**
 * Previous Carrier Settlements — Accounting visibility + Load Profit helpers.
 * Final carrier transportation payment stays on ShipmentLead.carrierRate / carrierPaidAt.
 */

export const PREVIOUS_CARRIER_SETTLEMENT_STATUSES = [
    "PENDING_ACCOUNTING",
    "APPROVED",
    "INVOICE_UPLOADED",
    "PAID",
    "REJECTED",
    "NO_PAYMENT_REQUIRED",
] as const;

export type PreviousCarrierSettlementStatus =
    (typeof PREVIOUS_CARRIER_SETTLEMENT_STATUSES)[number];

export type PreviousCarrierSettlementLike = {
    paymentAmount?: number | null;
    status?: string | null;
};

function money(v: number | null | undefined): number {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export function normalizeSettlementStatus(
    raw: string | null | undefined,
    paymentAmount: number | null | undefined
): PreviousCarrierSettlementStatus {
    const amount = money(paymentAmount);
    const s = String(raw || "")
        .trim()
        .toUpperCase();
    if ((PREVIOUS_CARRIER_SETTLEMENT_STATUSES as readonly string[]).includes(s)) {
        return s as PreviousCarrierSettlementStatus;
    }
    return amount > 0 ? "PENDING_ACCOUNTING" : "NO_PAYMENT_REQUIRED";
}

/** Accounting Previous Carrier Settlements: only paymentAmount > 0. */
export function settlementsVisibleToAccounting<T extends PreviousCarrierSettlementLike>(
    rows: T[]
): T[] {
    return (rows || []).filter((r) => money(r.paymentAmount) > 0);
}

/** Expense totals: exclude NO_PAYMENT_REQUIRED and REJECTED. Count once regardless of PAID. */
export function isSettlementPayableExpense(row: PreviousCarrierSettlementLike): boolean {
    const status = normalizeSettlementStatus(row.status, row.paymentAmount);
    if (status === "NO_PAYMENT_REQUIRED" || status === "REJECTED") return false;
    return money(row.paymentAmount) > 0;
}

export function sumPayablePreviousCarrierExpenses(
    rows: PreviousCarrierSettlementLike[] | null | undefined
): number {
    return Math.round(
        (rows || [])
            .filter(isSettlementPayableExpense)
            .reduce((sum, r) => sum + money(r.paymentAmount), 0) * 100
    ) / 100;
}

export function buildSettlementHistoryKey(input: {
    replacedAt?: string | null;
    carrierEmail?: string | null;
    carrierProfileId?: string | null;
    carrierName?: string | null;
}): string {
    return [
        String(input.replacedAt || "").trim(),
        String(input.carrierEmail || "")
            .trim()
            .toLowerCase(),
        String(input.carrierProfileId || "").trim(),
        String(input.carrierName || "")
            .trim()
            .toLowerCase(),
    ].join("|");
}

export function statusAfterInvoiceUpload(
    current: string | null | undefined,
    paymentAmount: number | null | undefined
): PreviousCarrierSettlementStatus {
    const cur = normalizeSettlementStatus(current, paymentAmount);
    if (cur === "PAID" || cur === "REJECTED" || cur === "NO_PAYMENT_REQUIRED") return cur;
    return "INVOICE_UPLOADED";
}

export type LoadFinancialSummaryInput = {
    customerPayment?: number | null;
    previousCarrierPayments?: number | null;
    finalCarrierPayment?: number | null;
    otherCarrierExpenses?: number | null;
    otherLoadExpenses?: number | null;
};

export function buildLoadFinancialSummary(input: LoadFinancialSummaryInput) {
    const customerPayment = money(input.customerPayment);
    const previousCarrierPayments = money(input.previousCarrierPayments);
    const finalCarrierPayment = money(input.finalCarrierPayment);
    const otherCarrierExpenses = money(input.otherCarrierExpenses);
    const otherLoadExpenses = money(input.otherLoadExpenses);
    const totalCarrierExpenses =
        Math.round(
            (previousCarrierPayments + finalCarrierPayment + otherCarrierExpenses) * 100
        ) / 100;
    const loadProfit =
        Math.round((customerPayment - totalCarrierExpenses - otherLoadExpenses) * 100) /
        100;
    return {
        customerPayment,
        previousCarrierPayments,
        finalCarrierPayment,
        otherCarrierExpenses,
        totalCarrierExpenses,
        otherLoadExpenses,
        loadProfit,
    };
}
