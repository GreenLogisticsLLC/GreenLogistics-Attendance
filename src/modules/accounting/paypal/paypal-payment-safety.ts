export const PAYPAL_PAYMENT_STATES = [
    "CREATED",
    "APPROVED",
    "CAPTURE_PENDING",
    "COMPLETED",
    "DENIED",
    "FAILED",
    "CANCELLED",
    "REFUNDED",
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
