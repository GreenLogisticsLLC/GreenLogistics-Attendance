import { STATUS_LABELS, type ShipmentStatus } from "./shipment.constants.js";

/** Map legacy CRM statuses onto Sprint A lifecycle. */
const ALIASES: Record<string, string> = {
    QUOTE_SENT: "BID_SUBMITTED",
    NEGOTIATION: "CUSTOMER_REPLIED",
    BOOKED: "ACCEPTED",
    WON: "COMPLETED",
    PICKED_UP: "DISPATCH",
    DELIVERED: "COMPLETED",
    ASSIGNED: "AWAITING_ACCEPTANCE",
};

export function normalizeStatus(status: string): string {
    const upper = (status || "NEW").toUpperCase();
    return ALIASES[upper] || upper;
}

export function statusLabel(status: string): string {
    const n = normalizeStatus(status);
    return STATUS_LABELS[n] || STATUS_LABELS[status] || status;
}

/**
 * Allowed transitions. Assignment path + marketplace lifecycle + load on same card.
 * CLOSED / LOST are mostly terminal (LOST may close).
 */
const ALLOWED: Record<string, string[]> = {
    NEW: ["UNASSIGNED", "AWAITING_ACCEPTANCE", "WORKING", "BID_SUBMITTED", "LOST"],
    UNASSIGNED: ["NEW", "AWAITING_ACCEPTANCE", "WORKING", "LOST"],
    AWAITING_ACCEPTANCE: ["WORKING", "FOLLOW_UP", "UNASSIGNED", "BID_SUBMITTED", "LOST"],
    WORKING: [
        "FOLLOW_UP",
        "BID_SUBMITTED",
        "CUSTOMER_REPLIED",
        "ACCEPTED",
        "LOAD_CREATED",
        "LOST",
    ],
    FOLLOW_UP: ["WORKING", "BID_SUBMITTED", "CUSTOMER_REPLIED", "AWAITING_ACCEPTANCE", "LOST"],
    BID_SUBMITTED: ["CUSTOMER_REPLIED", "ACCEPTED", "BID_SUBMITTED", "LOST", "WORKING"],
    CUSTOMER_REPLIED: ["BID_SUBMITTED", "ACCEPTED", "CUSTOMER_REPLIED", "LOST", "WORKING"],
    ACCEPTED: ["LOAD_CREATED", "DISPATCH", "COMPLETED", "LOST"],
    LOAD_CREATED: ["DISPATCH", "COMPLETED", "CLOSED", "LOST"],
    DISPATCH: ["COMPLETED", "CLOSED", "LOST"],
    COMPLETED: ["CLOSED"],
    CLOSED: [],
    LOST: ["CLOSED"],
};

export function canTransition(from: string, to: string): boolean {
    const a = normalizeStatus(from);
    const b = normalizeStatus(to);
    if (a === b) return true;
    const next = ALLOWED[a];
    if (!next) return true; // unknown → allow (forward-compat)
    return next.includes(b);
}

export function assertTransition(from: string, to: string) {
    if (!canTransition(from, to)) {
        throw Object.assign(
            new Error(
                `Invalid shipment lifecycle transition: ${normalizeStatus(from)} → ${normalizeStatus(to)}`
            ),
            { status: 422 }
        );
    }
}

/** Statuses at or after LOAD_CREATED — load number is allowed / expected. */
export function isLoadPhase(status: string): boolean {
    const n = normalizeStatus(status);
    return ["LOAD_CREATED", "DISPATCH", "COMPLETED", "CLOSED"].includes(n);
}

export function eventTypeForStatus(status: string): string {
    const n = normalizeStatus(status);
    const map: Record<string, string> = {
        NEW: "SHIPMENT_IMPORTED",
        UNASSIGNED: "SHIPMENT_UNASSIGNED",
        AWAITING_ACCEPTANCE: "BROKER_ASSIGNED",
        WORKING: "BROKER_ACCEPTED_WORK",
        BID_SUBMITTED: "BID_SUBMITTED",
        CUSTOMER_REPLIED: "CUSTOMER_REPLIED",
        ACCEPTED: "CUSTOMER_ACCEPTED",
        LOAD_CREATED: "LOAD_CREATED",
        DISPATCH: "DISPATCH_STARTED",
        COMPLETED: "SHIPMENT_COMPLETED",
        CLOSED: "SHIPMENT_CLOSED",
        LOST: "SHIPMENT_LOST",
        FOLLOW_UP: "STATUS_CHANGED",
    };
    return map[n] || "STATUS_CHANGED";
}

export type { ShipmentStatus };
