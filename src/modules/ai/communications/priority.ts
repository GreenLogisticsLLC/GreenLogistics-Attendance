import type { CommPriority } from "./types.js";

/**
 * Phase 7 communication priority rules:
 * CRITICAL = delivered shipment blocked by missing POD, or FOLLOW_UP with delivery issue terms.
 * HIGH = missing/requested compliance COI, NOA, W9, or authority.
 * MEDIUM = ordinary follow-up or an outstanding response.
 * LOW = informational context with no outstanding wait.
 */
export function communicationPriority(input: {
    shipmentStatus?: string | null;
    missingDocumentTypes?: string[];
    text?: string;
    waitingForResponse?: boolean;
}): CommPriority {
    const status = String(input.shipmentStatus || "").toUpperCase();
    const missing = (input.missingDocumentTypes || []).map((v) => v.toUpperCase());
    const text = String(input.text || "");
    if (
        (["DELIVERED", "COMPLETED", "CLOSED"].includes(status) && missing.includes("POD")) ||
        (status === "FOLLOW_UP" &&
            /\b(delivery|delivered|late|delay|damag|missing pod|receiver|appointment)\b/i.test(text))
    ) {
        return "CRITICAL";
    }
    if (missing.some((type) => ["COI", "NOA", "W9", "MC_AUTHORITY", "AUTHORITY"].includes(type))) {
        return "HIGH";
    }
    if (input.waitingForResponse || status === "FOLLOW_UP") return "MEDIUM";
    return "LOW";
}
