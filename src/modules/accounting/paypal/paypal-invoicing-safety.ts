import { createHash } from "crypto";
import {
    amountsMatchUsd,
    paypalAttemptIdempotencyKey,
    PAYPAL_WEBHOOK_PROCESSING_LEASE_MS,
} from "./paypal-payment-safety.js";

export { amountsMatchUsd, PAYPAL_WEBHOOK_PROCESSING_LEASE_MS };

/** PayPal invoice statuses that may still be paid (or are awaiting action). */
export const PAYPAL_INVOICE_OPEN_STATUSES = [
    "DRAFT",
    "SENT",
    "SCHEDULED",
    "UNPAID",
    "PAYMENT_PENDING",
    "PARTIALLY_PAID",
] as const;

/** Final money / lifecycle outcomes — a retry needs a new attempt, never a reopen. */
export const PAYPAL_INVOICE_TERMINAL_STATUSES = [
    "PAID",
    "MARKED_AS_PAID",
    "CANCELLED",
    "REFUNDED",
    "PARTIALLY_REFUNDED",
    "MARKED_AS_REFUNDED",
] as const;

export const MAX_INVOICING_ATTEMPTS = 64;
const PAYPAL_INVOICE_NUMBER_MAX = 25;

function norm(status: string | null | undefined): string {
    return String(status || "").trim().toUpperCase();
}

export function isOpenPayPalInvoiceStatus(status: string | null | undefined): boolean {
    return (PAYPAL_INVOICE_OPEN_STATUSES as readonly string[]).includes(norm(status));
}

export function isTerminalPayPalInvoiceStatus(status: string | null | undefined): boolean {
    return (PAYPAL_INVOICE_TERMINAL_STATUSES as readonly string[]).includes(norm(status));
}

/**
 * Retry-chain design (mirrors Checkout):
 * base = sha256("greenos-paypal-invoicing|shipment|cents|invoice|PAYPAL_INVOICING_MODE")[0..48]
 * attempt n >= 1 derives from base. Every closed attempt keeps its key forever;
 * a timeout never advances the chain (the same key / PayPal-Request-Id is retried).
 */
export function invoicingAttemptKey(
    shipmentLeadId: string,
    cents: number,
    invoiceNumber: string | null | undefined,
    invoicingMode: string,
    attempt: number
): string {
    const base = createHash("sha256")
        .update(
            [
                "greenos-paypal-invoicing",
                shipmentLeadId,
                String(Math.round(Number(cents))),
                invoiceNumber || "",
                invoicingMode === "live" ? "live" : "sandbox",
            ].join("|")
        )
        .digest("hex")
        .slice(0, 48);
    return paypalAttemptIdempotencyKey(base, attempt);
}

/** PayPal-Request-Id for the CREATE call of one attempt key. */
export function invoicingCreateRequestId(attemptKey: string): string {
    return createHash("sha256")
        .update(`greenos-paypal-invoice-create|${attemptKey}`)
        .digest("hex")
        .slice(0, 48);
}

/** Stable PayPal-Request-Id for a once-per-invoice action (send / cancel). */
export function invoicingActionRequestId(
    action: "send" | "cancel",
    paypalInvoiceId: string
): string {
    return createHash("sha256")
        .update(`greenos-paypal-invoice-${action}|${paypalInvoiceId}`)
        .digest("hex")
        .slice(0, 48);
}

/**
 * PayPal rejects duplicate invoice numbers and caps them at 25 chars, so retry
 * attempts after a closed invoice get a short `-R<n>` suffix.
 */
export function payPalInvoiceNumberForAttempt(baseNumber: string, attempt: number): string {
    const base = String(baseNumber || "").trim();
    if (attempt <= 0) return base.slice(0, PAYPAL_INVOICE_NUMBER_MAX);
    const suffix = `-R${attempt + 1}`;
    return base.slice(0, PAYPAL_INVOICE_NUMBER_MAX - suffix.length) + suffix;
}

export type PayPalInvoiceLifecycleRow = {
    status: string | null | undefined;
    environment?: string | null;
    totalUsd?: number | null;
    currency?: string | null;
    greenOsInvoiceNumber?: string | null;
};

/** Open invoice may be reused only when env + amount + currency (+ invoice number) match. */
export function isReusableOpenPayPalInvoice(
    row: PayPalInvoiceLifecycleRow,
    expected: {
        environment: string;
        totalUsd: number;
        currency?: string;
        invoiceNumber?: string | null;
    }
): boolean {
    if (!isOpenPayPalInvoiceStatus(row.status)) return false;
    const rowEnv = String(row.environment || "sandbox").toLowerCase();
    if (rowEnv !== String(expected.environment || "").toLowerCase()) return false;
    if (!amountsMatchUsd(row.totalUsd, expected.totalUsd)) return false;
    const currency = String(expected.currency || "USD").toUpperCase();
    if (String(row.currency || "USD").toUpperCase() !== currency) return false;
    const want = String(expected.invoiceNumber || "").trim();
    const have = String(row.greenOsInvoiceNumber || "").trim();
    if (want && have && want !== have) return false;
    return true;
}

export type InvoiceMoney = { value?: string | number | null; currency_code?: string | null };

function exactCents(value: string | number | null | undefined): number | null {
    if (value == null || value === "") return null;
    const raw = String(value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

/**
 * A PAID status alone is not payment proof. The paid amount must equal the
 * GreenOS invoice total to the cent, in the expected currency.
 */
export function verifyInvoicePaidAmount(input: {
    expectedTotalUsd: number;
    currency: string;
    invoiceAmount: InvoiceMoney | null | undefined;
}): { amountUsd: number; currency: string } {
    const expectedCurrency = String(input.currency || "USD").trim().toUpperCase();
    const actualCurrency = String(input.invoiceAmount?.currency_code || "").trim().toUpperCase();
    if (expectedCurrency !== "USD" || actualCurrency !== "USD") {
        throw Object.assign(
            new Error(
                `PayPal invoice currency mismatch (expected USD, received ${actualCurrency || "missing"})`
            ),
            { status: 409, code: "PAYPAL_INVOICE_CURRENCY_MISMATCH" }
        );
    }
    const actual = exactCents(input.invoiceAmount?.value);
    const expected = exactCents(input.expectedTotalUsd);
    if (actual == null || expected == null || actual !== expected) {
        throw Object.assign(
            new Error(
                `PayPal invoice paid amount mismatch (expected ${Number(input.expectedTotalUsd).toFixed(2)} USD)`
            ),
            { status: 409, code: "PAYPAL_INVOICE_AMOUNT_MISMATCH" }
        );
    }
    return { amountUsd: actual / 100, currency: "USD" };
}

/**
 * True when a PayPal call may have succeeded remotely despite an error response
 * (network failure, abort/timeout, 5xx, rate limit). The caller must retry with
 * the SAME PayPal-Request-Id and never mint a new key.
 */
export function isAmbiguousPayPalFailure(err: unknown): boolean {
    const e = err as { paypalStatus?: number; code?: string; name?: string } | null;
    if (!e) return true;
    if (e.code === "PAYPAL_OAUTH_FAILED" || e.code === "PAYPAL_INVOICING_NOT_CONFIGURED") {
        return false;
    }
    if (typeof e.paypalStatus === "number") {
        return e.paypalStatus >= 500 || e.paypalStatus === 408 || e.paypalStatus === 429;
    }
    return true;
}

export type PayPalInvoiceTransition =
    | { action: "apply" }
    | { action: "ignore"; reason: string };

/**
 * Remote status may only move forward. Stale DRAFT/SENT events never reopen a
 * CANCELLED / REFUNDED invoice, and a PAID invoice can only become refunded.
 */
export function decideInvoiceStatusTransition(
    currentStatus: string | null | undefined,
    nextStatus: string | null | undefined
): PayPalInvoiceTransition {
    const current = norm(currentStatus);
    const next = norm(nextStatus);
    if (!next) return { action: "ignore", reason: "empty_status" };
    if (current === next) return { action: "apply" };
    if (current === "CANCELLED" || current === "REFUNDED" || current === "MARKED_AS_REFUNDED") {
        return { action: "ignore", reason: `stale_status_on_${current.toLowerCase()}` };
    }
    if (current === "PAID" || current === "MARKED_AS_PAID" || current === "PARTIALLY_REFUNDED") {
        const refundish = ["REFUNDED", "PARTIALLY_REFUNDED", "MARKED_AS_REFUNDED"];
        if (refundish.includes(next)) return { action: "apply" };
        return { action: "ignore", reason: `stale_status_on_${current.toLowerCase()}` };
    }
    return { action: "apply" };
}
