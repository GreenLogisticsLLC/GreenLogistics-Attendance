export const PAYPAL_PAYMENT_STATES = [
    "CREATED",
    "APPROVED",
    "CAPTURE_PENDING",
    "COMPLETED",
    "DENIED",
    "FAILED",
    "CANCELLED",
    "REFUNDED",
    "REVERSED",
] as const;

export type PayPalPaymentState = (typeof PAYPAL_PAYMENT_STATES)[number];

export type CaptureEvidence = {
    captureId: string | null | undefined;
    status: string | null | undefined;
    amountValue: string | number | null | undefined;
    currencyCode: string | null | undefined;
};

export type VerifiedCapture = {
    captureId: string;
    amountUsd: number;
    currency: "USD";
};

function cents(value: string | number | null | undefined): number | null {
    if (value == null || value === "") return null;
    const raw = String(value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

/**
 * A capture ID is only an identifier. Payment proof requires a COMPLETED
 * capture whose amount and currency exactly match the server-side snapshot.
 */
export function verifyCompletedCapture(
    evidence: CaptureEvidence,
    expected: { amountUsd: number; currency: string }
): VerifiedCapture {
    const status = String(evidence.status || "").trim().toUpperCase();
    if (status !== "COMPLETED") {
        throw Object.assign(
            new Error(`PayPal capture is not completed (status ${status || "unknown"})`),
            { status: 409, code: "PAYPAL_CAPTURE_NOT_COMPLETED" }
        );
    }

    const captureId = String(evidence.captureId || "").trim();
    if (!captureId) {
        throw Object.assign(new Error("Completed PayPal capture is missing its capture id"), {
            status: 502,
            code: "PAYPAL_CAPTURE_ID_MISSING",
        });
    }

    const actualCurrency = String(evidence.currencyCode || "").trim().toUpperCase();
    const expectedCurrency = String(expected.currency || "").trim().toUpperCase();
    if (actualCurrency !== "USD" || expectedCurrency !== "USD") {
        throw Object.assign(
            new Error(
                `PayPal capture currency mismatch (expected USD, received ${actualCurrency || "missing"})`
            ),
            { status: 409, code: "PAYPAL_CAPTURE_CURRENCY_MISMATCH" }
        );
    }

    const actualCents = cents(evidence.amountValue);
    const expectedCents = cents(expected.amountUsd);
    if (actualCents == null || expectedCents == null || actualCents !== expectedCents) {
        throw Object.assign(
            new Error(
                `PayPal capture amount mismatch (expected ${expected.amountUsd.toFixed(2)} USD)`
            ),
            { status: 409, code: "PAYPAL_CAPTURE_AMOUNT_MISMATCH" }
        );
    }

    return {
        captureId,
        amountUsd: actualCents / 100,
        currency: "USD",
    };
}

export function stateForPayPalStatus(status: string | null | undefined): PayPalPaymentState {
    switch (String(status || "").trim().toUpperCase()) {
        case "APPROVED":
            return "APPROVED";
        case "COMPLETED":
            return "COMPLETED";
        case "PENDING":
        case "PAYER_ACTION_REQUIRED":
        case "SAVED":
            return "CAPTURE_PENDING";
        case "DENIED":
        case "DECLINED":
            return "DENIED";
        case "VOIDED":
        case "CANCELLED":
        case "CANCELED":
            return "CANCELLED";
        case "REFUNDED":
        case "PARTIALLY_REFUNDED":
            return "REFUNDED";
        case "REVERSED":
            return "REVERSED";
        case "FAILED":
            return "FAILED";
        default:
            return "CREATED";
    }
}

/**
 * The database claim must be atomic. Only its winner may call PayPal Capture;
 * all concurrent losers reconcile with GET and never perform a financial call.
 */
export async function runClaimedCapture<T>(input: {
    claim: () => Promise<boolean>;
    capture: () => Promise<T>;
    reconcile: () => Promise<T>;
}): Promise<T> {
    return (await input.claim()) ? input.capture() : input.reconcile();
}

/** Terminal money outcomes — never reopen as payable / paid without a new attempt. */
export const PAYPAL_TERMINAL_STATUSES = ["REFUNDED", "REVERSED"] as const;

export type PayPalLifecycleRow = {
    status: string | null | undefined;
    paidAt?: Date | null;
    refundedAt?: Date | null;
    reversedAt?: Date | null;
    reversalId?: string | null;
    needsAccountingReview?: boolean | null;
};

export function isReversedTerminal(row: PayPalLifecycleRow): boolean {
    return String(row.status || "").toUpperCase() === "REVERSED" || row.reversedAt != null;
}

export function isRefundedTerminal(row: PayPalLifecycleRow): boolean {
    return String(row.status || "").toUpperCase() === "REFUNDED" || row.refundedAt != null;
}

export function isPayPalTerminalState(row: PayPalLifecycleRow): boolean {
    return isReversedTerminal(row) || isRefundedTerminal(row);
}

/**
 * Prisma `where` fragment so status mutations never touch terminal rows.
 * Shared by webhook updateMany paths and capture claims.
 */
export function nonTerminalPayPalOrderWhere() {
    return {
        reversedAt: null,
        refundedAt: null,
        status: { notIn: [...PAYPAL_TERMINAL_STATUSES] },
    };
}

export type TerminalLifecycleDecision =
    | { action: "apply" }
    | { action: "ignore"; result: string; reason: string }
    | { action: "record_refund_on_reversed"; result: string; reason: string }
    | { action: "upgrade_refunded_to_reversed"; result: string; reason: string };

const STALE_LIFECYCLE_EVENTS = new Set([
    "CHECKOUT.ORDER.APPROVED",
    "CHECKOUT.ORDER.COMPLETED",
    "CHECKOUT.ORDER.VOIDED",
    "PAYMENT.CAPTURE.PENDING",
    "PAYMENT.CAPTURE.DENIED",
    "PAYMENT.CAPTURE.COMPLETED",
    "PAYMENT.CAPTURE.VOIDED",
]);

/**
 * Shared lifecycle transition rules for verified PayPal webhooks / status sync.
 * REVERSED and REFUNDED are terminal for the same payment attempt; out-of-order
 * refund+reverse keeps both financial facts with a deterministic final status.
 */
export function decideWebhookLifecycleTransition(input: {
    row: PayPalLifecycleRow;
    eventType: string;
}): TerminalLifecycleDecision {
    const eventType = String(input.eventType || "").trim();
    const reversed = isReversedTerminal(input.row);
    const refunded = isRefundedTerminal(input.row);

    if (reversed) {
        if (eventType === "PAYMENT.CAPTURE.REVERSED") {
            return {
                action: "ignore",
                result: "already_reversed",
                reason: "already_reversed",
            };
        }
        if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
            return {
                action: "record_refund_on_reversed",
                result: "refund_recorded_on_reversed",
                reason: "refund_after_reversed",
            };
        }
        if (STALE_LIFECYCLE_EVENTS.has(eventType)) {
            return {
                action: "ignore",
                result: "ignored_terminal_reversed",
                reason: "stale_event_on_reversed",
            };
        }
    }

    if (refunded) {
        if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
            return {
                action: "ignore",
                result: "already_refunded",
                reason: "already_refunded",
            };
        }
        if (eventType === "PAYMENT.CAPTURE.REVERSED") {
            return {
                action: "upgrade_refunded_to_reversed",
                result: "reversed",
                reason: "reverse_after_refund",
            };
        }
        if (STALE_LIFECYCLE_EVENTS.has(eventType)) {
            return {
                action: "ignore",
                result: "ignored_terminal_refunded",
                reason: "stale_event_on_refunded",
            };
        }
    }

    return { action: "apply" };
}
