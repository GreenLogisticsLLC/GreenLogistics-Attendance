/**
 * Customer payment methods + quote helpers.
 *
 * Handling fees come from Invoice Pricing settings (Accounting → Payment Settings).
 * They are method-neutral and DISABLED by default — never a PayPal-only surcharge.
 */

import {
    buildInvoicePricingBreakdown,
    defaultInvoicePricingSettings,
    parseInvoicePricingSnapshot,
    type InvoicePricingSettings,
    type InvoicePricingSnapshot,
} from "../accounting/invoice-pricing.js";

export const CUSTOMER_PAYMENT_METHODS = [
    { id: "WIRE", label: "Wire" },
    { id: "VENMO", label: "Venmo" },
    { id: "PAYPAL", label: "PayPal" },
    { id: "CREDIT_CARD", label: "Credit card" },
    { id: "CASHAPP", label: "Cash App" },
    { id: "ZELLE", label: "Zelle" },
    { id: "ACH", label: "ACH" },
] as const;

export type CustomerPaymentMethodId = (typeof CUSTOMER_PAYMENT_METHODS)[number]["id"];

const BY_ID = new Map(CUSTOMER_PAYMENT_METHODS.map((row) => [row.id, row]));

export function normalizeCustomerPaymentMethod(value: unknown): CustomerPaymentMethodId | null {
    const key = String(value || "")
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, "_");
    if (key === "CREDIT" || key === "CARD" || key === "CREDITCARD") return "CREDIT_CARD";
    if (key === "CASH_APP") return "CASHAPP";
    return BY_ID.has(key as CustomerPaymentMethodId) ? (key as CustomerPaymentMethodId) : null;
}

export type CustomerPaymentQuote = {
    method: CustomerPaymentMethodId | null;
    label: string | null;
    /** @deprecated Prefer feeConfiguredValue + feeType from invoice pricing. */
    feeRate: number;
    fee: number;
    waived: boolean;
    rate: number | null;
    accessorials: number;
    /** Rate + accessorials + handling fee (unless waived / disabled). */
    total: number | null;
    subtotal: number | null;
    feeType: "none" | "percentage" | "fixed";
    feeConfiguredValue: number;
    pricingVersion: number;
    lineItemLabel: string;
    lineItems: Array<{ code: string; label: string; amountUsd: number }>;
    /** True when totals came from a locked invoice snapshot. */
    fromSnapshot: boolean;
};

export function customerPaymentQuote(input: {
    customerRate?: unknown;
    accessorialCharges?: unknown;
    method?: unknown;
    waiveFee?: boolean | null;
    /** Live Invoice Pricing settings. Defaults to disabled (no fee). */
    pricing?: InvoicePricingSettings | null;
    /** Locked snapshot from a recorded invoice — wins over live settings. */
    pricingSnapshot?: InvoicePricingSnapshot | string | null;
}): CustomerPaymentQuote {
    const methodId = normalizeCustomerPaymentMethod(input.method);
    const method = methodId ? BY_ID.get(methodId)! : null;
    const settings = input.pricing || defaultInvoicePricingSettings();
    const snapshot =
        typeof input.pricingSnapshot === "string" || input.pricingSnapshot
            ? parseInvoicePricingSnapshot(input.pricingSnapshot)
            : null;

    const breakdown = buildInvoicePricingBreakdown({
        customerRate: input.customerRate,
        accessorialCharges: input.accessorialCharges,
        waiveFee: input.waiveFee,
        settings,
        snapshot,
    });

    // feeRate kept for older UI: percentage as fraction, else 0.
    const feeRate =
        breakdown.feeType === "percentage" ? breakdown.configuredValue / 100 : 0;

    return {
        method: methodId,
        label: method ? method.label : null,
        feeRate,
        fee: breakdown.feeAmountUsd,
        waived: breakdown.waived,
        rate: breakdown.rateUsd,
        accessorials: breakdown.accessorialsUsd,
        total: breakdown.totalUsd,
        subtotal: breakdown.subtotalUsd,
        feeType: breakdown.feeType,
        feeConfiguredValue: breakdown.configuredValue,
        pricingVersion: breakdown.pricingVersion,
        lineItemLabel: breakdown.lineItemLabel,
        lineItems: breakdown.lineItems,
        fromSnapshot: Boolean(snapshot),
    };
}

export function canWaiveCustomerPaymentFee(role: string | null | undefined): boolean {
    return (
        role === "Accounting" ||
        role === "Owner" ||
        role === "Manager" ||
        role === "Administrator"
    );
}

/** Same roles that may waive fees may record split / 50-50 customer payment days. */
export function canEditCustomerSplitPayments(role: string | null | undefined): boolean {
    return canWaiveCustomerPaymentFee(role);
}

/** Parse a money input; empty clears to null. Invalid throws via caller. */
export function parseCustomerPaymentAmount(value: unknown): number | null | "invalid" {
    if (value == null || value === "") return null;
    const n = Number(String(value).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) return "invalid";
    return Math.round(n * 100) / 100;
}

export function sumCustomerSplitPayments(input: {
    customerFirstPaymentAmount?: number | null;
    customerSecondPaymentAmount?: number | null;
}): number {
    const a = Number(input.customerFirstPaymentAmount);
    const b = Number(input.customerSecondPaymentAmount);
    const first = Number.isFinite(a) && a > 0 ? a : 0;
    const second = Number.isFinite(b) && b > 0 ? b : 0;
    return Math.round((first + second) * 100) / 100;
}
