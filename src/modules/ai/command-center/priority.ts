import type {
    AiOperationalCategory,
    AiOperationalItem,
    AiOperationalPriority,
} from "./types.js";

export const PRIORITY_ORDER: Record<AiOperationalPriority, number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
    INFO: 4,
};

const CATEGORY_ORDER: Record<AiOperationalCategory, number> = {
    SHIPMENT: 0,
    COMPLIANCE: 1,
    DOCUMENT: 2,
    COMMUNICATION: 3,
    FOLLOW_UP: 4,
    MARKET: 5,
    CARRIER: 6,
    INTERNAL_REVIEW: 7,
};

/**
 * Exact Phase 8 priority rules:
 * CRITICAL — shipment delivery blocker (missing/unsigned POD when closing matters),
 * NOT_READY with a critical mismatch, or compliance CRITICAL_MISMATCH.
 * HIGH — missing required compliance documents, carrier NOT_READY, shipment not
 * ready when action is needed, blocking communication, or quote ABOVE_P75.
 * MEDIUM — quote BELOW_P25/review, normal follow-up, or pending response.
 * LOW — informational operational context. INFO — recommendation-only.
 */
export function determineOperationalPriority(input: {
    category?: AiOperationalCategory;
    entityType?: "shipment" | "carrier";
    readiness?: string | null;
    status?: string | null;
    documentStatus?: string | null;
    documentType?: string | null;
    mismatchStatus?: string | null;
    marketAssessment?: string | null;
    blocking?: boolean;
    followUpNeeded?: boolean;
    recommendationOnly?: boolean;
    closingMatters?: boolean;
}): AiOperationalPriority {
    const mismatch = String(input.mismatchStatus || "").toUpperCase();
    const readiness = String(input.readiness || "").toUpperCase();
    const docStatus = String(input.documentStatus || "").toUpperCase();
    const docType = String(input.documentType || "").toUpperCase();
    const assessment = String(input.marketAssessment || "").toUpperCase();

    if (
        mismatch === "CRITICAL_MISMATCH" ||
        ((input.category === "SHIPMENT" || input.entityType === "shipment") &&
            input.closingMatters &&
            docType === "POD" &&
            ["MISSING", "INVALID", "EXPIRED", "REVIEW_REQUIRED"].includes(docStatus)) ||
        (readiness === "NOT_READY" && mismatch === "CRITICAL_MISMATCH")
    ) {
        return "CRITICAL";
    }
    if (
        assessment === "ABOVE_HISTORICAL_P75" ||
        (input.blocking && input.category === "COMMUNICATION") ||
        readiness === "NOT_READY" ||
        (input.category === "CARRIER" && readiness === "NOT_READY") ||
        (input.category === "DOCUMENT" &&
            ["MISSING", "INVALID", "EXPIRED"].includes(docStatus))
    ) {
        return "HIGH";
    }
    if (
        assessment === "BELOW_HISTORICAL_P25" ||
        input.followUpNeeded ||
        ["REVIEW_REQUIRED", "INCOMPLETE"].includes(readiness) ||
        input.status === "PENDING_RESPONSE"
    ) {
        return "MEDIUM";
    }
    if (input.recommendationOnly) return "INFO";
    return "LOW";
}

export function sortOperationalItems(items: AiOperationalItem[]): AiOperationalItem[] {
    return [...items].sort((a, b) => {
        const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (byPriority) return byPriority;
        const aBlocker = a.category === "SHIPMENT" && a.blocking ? 0 : 1;
        const bBlocker = b.category === "SHIPMENT" && b.blocking ? 0 : 1;
        if (aBlocker !== bBlocker) return aBlocker - bBlocker;
        const byCategory = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
        if (byCategory) return byCategory;
        return a.dedupeKey.localeCompare(b.dedupeKey);
    });
}
