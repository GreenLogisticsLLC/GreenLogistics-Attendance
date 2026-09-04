import { STATUS_LABELS, type ShipmentStatus } from "./shipment.constants.js";

/** Map legacy CRM statuses onto current lifecycle. */
const ALIASES: Record<string, string> = {
    QUOTE_SENT: "BID_SUBMITTED",
    NEGOTIATION: "CUSTOMER_REPLIED",
    BOOKED: "ACCEPT_GREEN",
    ACCEPTED: "ACCEPT_GREEN",
    WON: "COMPLETED",
    PICKED_UP: "PICKUP",
    ASSIGNED: "AWAITING_ACCEPTANCE",
    DELETED: "DELETED_FROM_CUSTOMER",
};

export function normalizeStatus(status: string): string {
    const upper = (status || "NEW").toUpperCase();
    return ALIASES[upper] || upper;
}

export function statusLabel(status: string): string {
    const n = normalizeStatus(status);
    return STATUS_LABELS[n] || STATUS_LABELS[status] || status;
}

const LOAD_FLOW = [
    "LOAD_CREATED",
    "CARRIER_ASSIGNED",
    "RATE_CON_GENERATED",
    "CARRIER_ACCEPTED",
    "PICKUP",
    "IN_TRANSIT",
    "DELIVERED",
    "POD_UPLOADED",
    "CUSTOMER_INVOICE",
    "CARRIER_PAYMENT",
    "DISPATCH",
    "COMPLETED",
    "CLOSED",
];

/**
 * Allowed transitions. Assignment path + marketplace + load ops on same card.
 * CLOSED / LOST / ACCEPTED_ANOTHER_COMPANY / DELETED_FROM_CUSTOMER are terminal
 * (customer booked elsewhere or deleted listing on uShip).
 */
const ALLOWED: Record<string, string[]> = {
    NEW: [
        "UNASSIGNED",
        "AWAITING_ACCEPTANCE",
        "AGENT_OPEN",
        "WORKING",
        "BID_SUBMITTED",
        "LOST",
        "ACCEPTED_ANOTHER_COMPANY",
        "DELETED_FROM_CUSTOMER",
    ],
    UNASSIGNED: [
        "NEW",
        "AWAITING_ACCEPTANCE",
        "AGENT_OPEN",
        "WORKING",
        "LOST",
        "ACCEPTED_ANOTHER_COMPANY",
        "DELETED_FROM_CUSTOMER",
    ],
    AWAITING_ACCEPTANCE: [
        "AGENT_OPEN",
        "WORKING",
        "FOLLOW_UP",
        "UNASSIGNED",
        "BID_SUBMITTED",
        "LOST",
        "ACCEPTED_ANOTHER_COMPANY",
        "DELETED_FROM_CUSTOMER",
    ],
    AGENT_OPEN: [
        "WORKING",
        "FOLLOW_UP",
        "BROKER_REPLY",
        "UNASSIGNED",
        "BID_SUBMITTED",
        "CUSTOMER_REPLIED",
        "LOST",
        "ACCEPTED_ANOTHER_COMPANY",
        "DELETED_FROM_CUSTOMER",
    ],
    WORKING: [
        "FOLLOW_UP",
        "BROKER_REPLY",
        "BID_SUBMITTED",
        "CUSTOMER_REPLIED",
        "ACCEPT_GREEN",
        "LOAD_CREATED",
        "LOST",
        "ACCEPTED_ANOTHER_COMPANY",
        "DELETED_FROM_CUSTOMER",
    ],
    FOLLOW_UP: [
        "AGENT_OPEN",
        "WORKING",
        "BID_SUBMITTED",
        "CUSTOMER_REPLIED",
        "BROKER_REPLY",
        "AWAITING_ACCEPTANCE",
        "LOST",
        "ACCEPTED_ANOTHER_COMPANY",
        "DELETED_FROM_CUSTOMER",
    ],
    BROKER_REPLY: [
        "AGENT_OPEN",
        "WORKING",
        "BID_SUBMITTED",
        "CUSTOMER_REPLIED",
        "FOLLOW_UP",
        "ACCEPT_GREEN",
        "AWAITING_ACCEPTANCE",
        "LOST",
        "ACCEPTED_ANOTHER_COMPANY",
        "DELETED_FROM_CUSTOMER",
    ],
    BID_SUBMITTED: [
        "CUSTOMER_REPLIED",
        "ACCEPT_GREEN",
        "BID_SUBMITTED",
        "LOST",
        "ACCEPTED_ANOTHER_COMPANY",
        "WORKING",
        "DELETED_FROM_CUSTOMER",
    ],
    CUSTOMER_REPLIED: [
        "BID_SUBMITTED",
        "ACCEPT_GREEN",
        "CUSTOMER_REPLIED",
        "BROKER_REPLY",
        "FOLLOW_UP",
        "LOST",
        "ACCEPTED_ANOTHER_COMPANY",
        "WORKING",
        "DELETED_FROM_CUSTOMER",
    ],
    ACCEPT_GREEN: ["LOAD_CREATED", "DISPATCH", "COMPLETED", "LOST", "DELETED_FROM_CUSTOMER"],
    ACCEPTED: ["LOAD_CREATED", "DISPATCH", "COMPLETED", "LOST", "DELETED_FROM_CUSTOMER"],
    LOAD_CREATED: [
        "CARRIER_ASSIGNED",
        "RATE_CON_GENERATED",
        "DISPATCH",
        "COMPLETED",
        "CLOSED",
        "LOST",
        "ACCEPTED_ANOTHER_COMPANY",
        "DELETED_FROM_CUSTOMER",
    ],
    CARRIER_ASSIGNED: [
        "RATE_CON_GENERATED",
        "CARRIER_ACCEPTED",
        "DISPATCH",
        "CLOSED",
        "LOST",
        "DELETED_FROM_CUSTOMER",
    ],
    RATE_CON_GENERATED: [
        "CARRIER_ACCEPTED",
        "PICKUP",
        "DISPATCH",
        "CLOSED",
        "LOST",
        "DELETED_FROM_CUSTOMER",
    ],
    CARRIER_ACCEPTED: ["PICKUP", "IN_TRANSIT", "DISPATCH", "CLOSED", "LOST", "DELETED_FROM_CUSTOMER"],
    PICKUP: ["IN_TRANSIT", "DELIVERED", "POD_UPLOADED", "DISPATCH", "CLOSED", "LOST", "DELETED_FROM_CUSTOMER"],
    IN_TRANSIT: ["DELIVERED", "POD_UPLOADED", "CLOSED", "LOST", "DELETED_FROM_CUSTOMER"],
    DELIVERED: ["POD_UPLOADED", "CUSTOMER_INVOICE", "COMPLETED", "CLOSED", "LOST", "DELETED_FROM_CUSTOMER"],
    POD_UPLOADED: ["CUSTOMER_INVOICE", "CARRIER_PAYMENT", "COMPLETED", "CLOSED", "LOST", "DELETED_FROM_CUSTOMER"],
    CUSTOMER_INVOICE: ["CARRIER_PAYMENT", "COMPLETED", "CLOSED", "LOST", "DELETED_FROM_CUSTOMER"],
    CARRIER_PAYMENT: ["COMPLETED", "CLOSED", "LOST", "DELETED_FROM_CUSTOMER"],
    DISPATCH: [
        "CARRIER_ASSIGNED",
        "RATE_CON_GENERATED",
        "CARRIER_ACCEPTED",
        "PICKUP",
        "IN_TRANSIT",
        "DELIVERED",
        "POD_UPLOADED",
        "COMPLETED",
        "CLOSED",
        "LOST",
        "DELETED_FROM_CUSTOMER",
    ],
    COMPLETED: ["CLOSED", "CUSTOMER_INVOICE", "CARRIER_PAYMENT", "DELETED_FROM_CUSTOMER"],
    CLOSED: [],
    LOST: ["CLOSED"],
    ACCEPTED_ANOTHER_COMPANY: ["CLOSED"],
    DELETED_FROM_CUSTOMER: [],
};

export function canTransition(from: string, to: string): boolean {
    const a = normalizeStatus(from);
    const b = normalizeStatus(to);
    if (a === b) return true;
    if (b === "DELETED_FROM_CUSTOMER" && a !== "CLOSED") return true;
    if (b === "ACCEPTED_ANOTHER_COMPANY" && a !== "CLOSED" && a !== "ACCEPT_GREEN") return true;
    const next = ALLOWED[a];
    if (!next) return true;
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
    return LOAD_FLOW.includes(n);
}

export function eventTypeForStatus(status: string): string {
    const n = normalizeStatus(status);
    const map: Record<string, string> = {
        NEW: "SHIPMENT_IMPORTED",
        UNASSIGNED: "SHIPMENT_UNASSIGNED",
        AWAITING_ACCEPTANCE: "BROKER_ASSIGNED",
        AGENT_OPEN: "AGENT_OPENED",
        WORKING: "BROKER_ACCEPTED_WORK",
        BID_SUBMITTED: "BID_SUBMITTED",
        CUSTOMER_REPLIED: "CUSTOMER_RESPOND",
        ACCEPT_GREEN: "CUSTOMER_ACCEPTED",
        ACCEPTED: "CUSTOMER_ACCEPTED",
        ACCEPTED_ANOTHER_COMPANY: "SHIPMENT_ACCEPTED_ANOTHER_COMPANY",
        LOAD_CREATED: "LOAD_CREATED",
        CARRIER_ASSIGNED: "CARRIER_ASSIGNED",
        RATE_CON_GENERATED: "RATE_CONFIRMATION_GENERATED",
        CARRIER_ACCEPTED: "CARRIER_ACCEPTED",
        PICKUP: "PICKUP_MARKED",
        IN_TRANSIT: "IN_TRANSIT_MARKED",
        DELIVERED: "DELIVERED_MARKED",
        POD_UPLOADED: "POD_UPLOADED",
        CUSTOMER_INVOICE: "CUSTOMER_INVOICE_GENERATED",
        CARRIER_PAYMENT: "CARRIER_PAID",
        DISPATCH: "DISPATCH_STARTED",
        COMPLETED: "SHIPMENT_COMPLETED",
        CLOSED: "SHIPMENT_CLOSED",
        LOST: "SHIPMENT_LOST",
        DELETED_FROM_CUSTOMER: "SHIPMENT_DELETED_BY_CUSTOMER",
        FOLLOW_UP: "STATUS_CHANGED",
        BROKER_REPLY: "BROKER_QUESTION",
    };
    return map[n] || "STATUS_CHANGED";
}

export type { ShipmentStatus };
