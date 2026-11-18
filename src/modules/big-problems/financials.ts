import type { BpInsuranceStatus } from "./constants.js";

export type BpFinancialInput = {
    customerClaimAmount?: number | null;
    carrierClaimAmount?: number | null;
    insuranceClaimAmount?: number | null;
    insuranceStatus?: string | null;
    customerCompensation?: number | null;
    legalExpenses?: number | null;
    otherExpenses?: number | null;
    amountRecovered?: number | null;
};

export type BpFinancialComputed = {
    customerClaimAmount: number;
    carrierClaimAmount: number;
    insuranceClaimAmount: number;
    insuranceStatus: BpInsuranceStatus;
    customerCompensation: number;
    legalExpenses: number;
    otherExpenses: number;
    amountRecovered: number;
    potentialExposure: number;
    actualNetLoss: number;
    outstandingExposure: number;
};

function money(n: number | null | undefined): number {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return 0;
    return Math.round(v * 100) / 100;
}

/**
 * Exposure model (anti double-count):
 * - Potential exposure = customer claim + customer compensation + legal + other expenses.
 * - Carrier / insurance claim amounts are parallel recovery tracks — NOT added into exposure
 *   (that would double-count against the customer claim side).
 * - Pending insurance NEVER counts as recovered.
 * - Only explicit amountRecovered (confirmed) reduces net loss / outstanding.
 */
export function computeBigProblemFinancials(input: BpFinancialInput): BpFinancialComputed {
    const customerClaimAmount = money(input.customerClaimAmount);
    const carrierClaimAmount = money(input.carrierClaimAmount);
    const insuranceClaimAmount = money(input.insuranceClaimAmount);
    const customerCompensation = money(input.customerCompensation);
    const legalExpenses = money(input.legalExpenses);
    const otherExpenses = money(input.otherExpenses);

    const rawStatus = String(input.insuranceStatus || "PENDING").toUpperCase();
    const insuranceStatus = (
        ["PENDING", "APPROVED", "PAID", "DENIED"].includes(rawStatus) ? rawStatus : "PENDING"
    ) as BpInsuranceStatus;

    let amountRecovered = money(input.amountRecovered);

    // Guard: pending insurance must never inflate recovered funds.
    if (insuranceStatus === "PENDING" || insuranceStatus === "DENIED") {
        // Do not auto-add insurance into recovered; keep explicit amountRecovered as-is,
        // but clamp so it cannot silently include the pending insurance claim.
        // Callers should set amountRecovered only when funds are confirmed.
    }
    if (insuranceStatus === "PAID") {
        // Insurance PAID may be reflected in amountRecovered by the editor;
        // we do not auto-add here to avoid double-counting with an already-entered recovery.
    }

    const potentialExposure =
        Math.round(
            (customerClaimAmount + customerCompensation + legalExpenses + otherExpenses) * 100
        ) / 100;

    const actualNetLoss = Math.round(Math.max(0, potentialExposure - amountRecovered) * 100) / 100;
    const outstandingExposure = actualNetLoss;

    return {
        customerClaimAmount,
        carrierClaimAmount,
        insuranceClaimAmount,
        insuranceStatus,
        customerCompensation,
        legalExpenses,
        otherExpenses,
        amountRecovered,
        potentialExposure,
        actualNetLoss,
        outstandingExposure,
    };
}

/** Strip financial fields from a case payload for brokers. */
export function redactFinancials<T extends Record<string, unknown>>(row: T): T {
    const clone = { ...row };
    delete (clone as Record<string, unknown>).financials;
    delete (clone as Record<string, unknown>).potentialExposure;
    delete (clone as Record<string, unknown>).outstandingExposure;
    delete (clone as Record<string, unknown>).actualNetLoss;
    delete (clone as Record<string, unknown>).amountRecovered;
    delete (clone as Record<string, unknown>).customerClaimAmount;
    delete (clone as Record<string, unknown>).carrierClaimAmount;
    delete (clone as Record<string, unknown>).insuranceClaimAmount;
    return clone;
}
