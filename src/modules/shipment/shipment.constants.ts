/**
 * Shipment Aggregate — lifecycle + domain events (Sprint A foundation).
 *
 * Assignment statuses (UNASSIGNED / AWAITING_ACCEPTANCE / WORKING) coexist with
 * marketplace lifecycle (BID_SUBMITTED → … → CLOSED). One card forever.
 */

/** Primary marketplace + ops lifecycle (Sprint A). */
export const SHIPMENT_LIFECYCLE = [
    "NEW",
    "BID_SUBMITTED",
    "CUSTOMER_REPLIED",
    "ACCEPTED",
    "LOAD_CREATED",
    "DISPATCH",
    "COMPLETED",
    "CLOSED",
] as const;

export type ShipmentLifecycleStatus = (typeof SHIPMENT_LIFECYCLE)[number];

/** Full status set including Assignment Engine states + legacy aliases. */
export const SHIPMENT_STATUSES = [
    "NEW",
    "UNASSIGNED",
    "ASSIGNED",
    "AWAITING_ACCEPTANCE",
    "WORKING",
    "FOLLOW_UP",
    "BID_SUBMITTED",
    "CUSTOMER_REPLIED",
    "ACCEPTED",
    "LOAD_CREATED",
    "DISPATCH",
    "COMPLETED",
    "CLOSED",
    "LOST",
    // Legacy aliases (normalized by lifecycle.normalizeStatus)
    "QUOTE_SENT",
    "NEGOTIATION",
    "BOOKED",
    "PICKED_UP",
    "DELIVERED",
    "WON",
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number] | string;

export const STATUS_LABELS: Record<string, string> = {
    NEW: "New",
    UNASSIGNED: "Unassigned",
    ASSIGNED: "Assigned",
    AWAITING_ACCEPTANCE: "Awaiting Acceptance",
    WORKING: "Working",
    FOLLOW_UP: "Follow Up",
    BID_SUBMITTED: "Bid Submitted",
    CUSTOMER_REPLIED: "Customer Replied",
    ACCEPTED: "Accepted",
    LOAD_CREATED: "Load Created",
    DISPATCH: "Dispatch",
    COMPLETED: "Completed",
    CLOSED: "Closed",
    LOST: "Lost",
    QUOTE_SENT: "Bid Submitted",
    NEGOTIATION: "Customer Replied",
    BOOKED: "Accepted",
    PICKED_UP: "Dispatch",
    DELIVERED: "Completed",
    WON: "Completed",
};

/** Domain event catalog — Timeline / Notifications / CRM / Analytics all consume these. */
export const DOMAIN_EVENT_TYPES = [
    "SHIPMENT_IMPORTED",
    "SHIPMENT_UNASSIGNED",
    "BROKER_ASSIGNED",
    "BROKER_ACCEPTED_WORK",
    "BID_SUBMITTED",
    "CUSTOMER_REPLIED",
    "CUSTOMER_ACCEPTED",
    "LOAD_CREATED",
    "DISPATCH_STARTED",
    "SHIPMENT_COMPLETED",
    "SHIPMENT_CLOSED",
    "SHIPMENT_LOST",
    "STATUS_CHANGED",
    "NOTE_ADDED",
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number] | string;

export const LIFECYCLE_PIPELINE = [
    { stage: "SHIPMENT_IMPORTED", title: "Shipment Imported", status: "NEW" },
    { stage: "BROKER_ASSIGNED", title: "Broker Assigned", status: "AWAITING_ACCEPTANCE" },
    { stage: "BROKER_ACCEPTED_WORK", title: "Broker Accepted Work", status: "WORKING" },
    { stage: "BID_SUBMITTED", title: "Bid Submitted", status: "BID_SUBMITTED" },
    { stage: "CUSTOMER_REPLIED", title: "Customer Replied", status: "CUSTOMER_REPLIED" },
    { stage: "CUSTOMER_ACCEPTED", title: "Customer Accepted", status: "ACCEPTED" },
    { stage: "LOAD_CREATED", title: "Load Created", status: "LOAD_CREATED" },
    { stage: "DISPATCH_STARTED", title: "Dispatch", status: "DISPATCH" },
    { stage: "SHIPMENT_COMPLETED", title: "Completed", status: "COMPLETED" },
    { stage: "SHIPMENT_CLOSED", title: "Closed", status: "CLOSED" },
] as const;

export const ACTIVE_STATUSES = [
    "NEW",
    "UNASSIGNED",
    "ASSIGNED",
    "AWAITING_ACCEPTANCE",
    "WORKING",
    "FOLLOW_UP",
    "BID_SUBMITTED",
    "CUSTOMER_REPLIED",
    "ACCEPTED",
    "LOAD_CREATED",
    "DISPATCH",
    "QUOTE_SENT",
    "NEGOTIATION",
    "BOOKED",
    "PICKED_UP",
    "DELIVERED",
] as const;
