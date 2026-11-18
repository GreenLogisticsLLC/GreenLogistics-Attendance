/** Carrier Change — enums + validation (broker Previous Carrier Information). */

export const CARRIER_CHANGE_REASONS = [
    "CARRIER_CANCELLATION",
    "CARRIER_FAILED_TO_PERFORM",
    "RATE_DISAGREEMENT",
    "LATE_PICKUP",
    "EQUIPMENT_PROBLEM",
    "INSURANCE_COMPLIANCE_ISSUE",
    "CUSTOMER_REQUEST",
    "OTHER",
] as const;

export type CarrierChangeReason = (typeof CARRIER_CHANGE_REASONS)[number];

export const CARRIER_CHANGE_REASON_LABELS: Record<CarrierChangeReason, string> = {
    CARRIER_CANCELLATION: "Carrier Cancellation",
    CARRIER_FAILED_TO_PERFORM: "Carrier Failed to Perform",
    RATE_DISAGREEMENT: "Rate Disagreement",
    LATE_PICKUP: "Late Pickup",
    EQUIPMENT_PROBLEM: "Equipment Problem",
    INSURANCE_COMPLIANCE_ISSUE: "Insurance / Compliance Issue",
    CUSTOMER_REQUEST: "Customer Request",
    OTHER: "Other",
};

export const PREVIOUS_CARRIER_STATUSES = [
    "CANCELLED_BEFORE_PICKUP",
    "CANCELLED_AFTER_PICKUP",
    "LOADED_NOT_DELIVERED",
    "DELIVERED",
    "FAILED_TO_PERFORM",
    "OTHER",
] as const;

export type PreviousCarrierStatusCode = (typeof PREVIOUS_CARRIER_STATUSES)[number];

export const PREVIOUS_CARRIER_STATUS_LABELS: Record<PreviousCarrierStatusCode, string> = {
    CANCELLED_BEFORE_PICKUP: "Cancelled Before Pickup",
    CANCELLED_AFTER_PICKUP: "Cancelled After Pickup",
    LOADED_NOT_DELIVERED: "Loaded, Not Delivered",
    DELIVERED: "Delivered",
    FAILED_TO_PERFORM: "Failed to Perform",
    OTHER: "Other",
};

export const PREVIOUS_PAYMENT_REASONS = [
    "LAYOVER",
    "DETENTION",
    "TONU",
    "CANCELLATION_FEE",
    "PARTIAL_TRANSPORTATION_PAYMENT",
    "OTHER",
] as const;

export type PreviousPaymentReason = (typeof PREVIOUS_PAYMENT_REASONS)[number];

export const PREVIOUS_PAYMENT_REASON_LABELS: Record<PreviousPaymentReason, string> = {
    LAYOVER: "Layover",
    DETENTION: "Detention",
    TONU: "TONU",
    CANCELLATION_FEE: "Cancellation Fee",
    PARTIAL_TRANSPORTATION_PAYMENT: "Partial Transportation Payment",
    OTHER: "Other",
};

export const LOAD_CARRIER_ASSIGNMENT_STATUSES = [
    "ACTIVE",
    "REPLACED",
    "REPLACEMENT_PENDING",
    "CANCELLED",
] as const;

export type LoadCarrierAssignmentStatus =
    (typeof LOAD_CARRIER_ASSIGNMENT_STATUSES)[number];

export const CARRIER_CHANGE_LOAD_STATUS = {
    ReplacementInProgress: "REPLACEMENT_IN_PROGRESS",
} as const;

export type CarrierChangePreviousInfoInput = {
    changeReason?: string | null;
    previousCarrierStatus?: string | null;
    paymentAmount?: number | string | null;
    paymentReason?: string | null;
    brokerComment?: string | null;
};

export type CarrierChangePreviousInfo = {
    changeReason: CarrierChangeReason;
    previousCarrierStatus: PreviousCarrierStatusCode;
    paymentAmount: number;
    paymentReason: PreviousPaymentReason;
    brokerComment: string | null;
};

function asEnum<T extends string>(
    raw: string | null | undefined,
    allowed: readonly T[],
    label: string
): T {
    const v = String(raw || "")
        .trim()
        .toUpperCase()
        .replace(/[\s/-]+/g, "_");
    if ((allowed as readonly string[]).includes(v)) return v as T;
    throw Object.assign(new Error(`Invalid ${label}`), { status: 422, code: "CARRIER_CHANGE_INVALID" });
}

export function parsePaymentAmount(raw: number | string | null | undefined): number {
    if (raw == null || raw === "") {
        throw Object.assign(new Error("Payment Amount is required (use 0 if none)"), {
            status: 422,
            code: "CARRIER_CHANGE_INVALID",
        });
    }
    const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n)) {
        throw Object.assign(new Error("Payment Amount must be a number"), {
            status: 422,
            code: "CARRIER_CHANGE_INVALID",
        });
    }
    if (n < 0) {
        throw Object.assign(new Error("Payment Amount cannot be negative"), {
            status: 422,
            code: "CARRIER_CHANGE_INVALID",
        });
    }
    return Math.round(n * 100) / 100;
}

export function validateCarrierChangePreviousInfo(
    input: CarrierChangePreviousInfoInput
): CarrierChangePreviousInfo {
    const changeReason = asEnum(input.changeReason, CARRIER_CHANGE_REASONS, "Carrier Change Reason");
    const previousCarrierStatus = asEnum(
        input.previousCarrierStatus,
        PREVIOUS_CARRIER_STATUSES,
        "Previous Carrier Status"
    );
    const paymentReason = asEnum(
        input.paymentReason,
        PREVIOUS_PAYMENT_REASONS,
        "Payment Reason"
    );
    const paymentAmount = parsePaymentAmount(input.paymentAmount);
    const brokerComment = input.brokerComment
        ? String(input.brokerComment).trim() || null
        : null;
    return {
        changeReason,
        previousCarrierStatus,
        paymentAmount,
        paymentReason,
        brokerComment,
    };
}

export function paymentReasonLabel(code: string | null | undefined): string {
    const k = String(code || "").toUpperCase() as PreviousPaymentReason;
    return PREVIOUS_PAYMENT_REASON_LABELS[k] || String(code || "—");
}

export function changeReasonLabel(code: string | null | undefined): string {
    const k = String(code || "").toUpperCase() as CarrierChangeReason;
    return CARRIER_CHANGE_REASON_LABELS[k] || String(code || "—");
}

export function previousStatusLabel(code: string | null | undefined): string {
    const k = String(code || "").toUpperCase() as PreviousCarrierStatusCode;
    return PREVIOUS_CARRIER_STATUS_LABELS[k] || String(code || "—");
}
