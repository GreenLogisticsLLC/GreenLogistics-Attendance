/**
 * Shipment Aggregate — lifecycle + domain events (Sprint A foundation).
 *
 * Assignment statuses (UNASSIGNED / AWAITING_ACCEPTANCE / AGENT_OPEN / WORKING) coexist with
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
    "AGENT_OPEN",
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
    "DELETED_FROM_CUSTOMER",
    // Legacy aliases (normalized by lifecycle.normalizeStatus)
    "QUOTE_SENT",
    "NEGOTIATION",
    "BOOKED",
    "PICKED_UP",
    "DELIVERED",
    "WON",
    "DELETED",
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number] | string;

/**
 * Pipeline stages driven by uShip / broker Gmail — not pickable in the CRM status dropdown.
 * Manual CRM updates may still use FOLLOW_UP, DISPATCH, COMPLETED, CLOSED, LOST, etc.
 */
export const AUTO_PIPELINE_STATUSES = [
    "AGENT_OPEN",
    "WORKING",
    "BID_SUBMITTED",
    "CUSTOMER_REPLIED",
    "ACCEPTED",
    "LOAD_CREATED",
    "BOOKED",
    "WON",
] as const;

export const MANUAL_CRM_STATUSES = [
    "FOLLOW_UP",
    "DISPATCH",
    "COMPLETED",
    "CLOSED",
    "LOST",
    "DELETED_FROM_CUSTOMER",
    "QUOTE_SENT",
    "NEGOTIATION",
] as const;

export const STATUS_LABELS: Record<string, string> = {
    NEW: "New",
    UNASSIGNED: "Unassigned",
    ASSIGNED: "Awaiting Agent",
    AWAITING_ACCEPTANCE: "Awaiting Agent",
    AGENT_OPEN: "Agent Open",
    WORKING: "Agent Working",
    FOLLOW_UP: "Follow Up",
    BID_SUBMITTED: "Bid Submitted",
    CUSTOMER_REPLIED: "Customer Respond",
    ACCEPTED: "Accepted",
    LOAD_CREATED: "Load Created",
    DISPATCH: "Dispatch",
    COMPLETED: "Completed",
    CLOSED: "Closed",
    LOST: "Lost",
    DELETED_FROM_CUSTOMER: "Deleted from Customer",
    DELETED: "Deleted from Customer",
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
    "AGENT_OPENED",
    "AGENT_STARTED_WORK",
    "BROKER_ACCEPTED_WORK",
    "BID_SUBMITTED",
    "BROKER_QUESTION",
    "CUSTOMER_RESPOND",
    "CUSTOMER_REPLIED",
    "CUSTOMER_ACCEPTED",
    "LOAD_CREATED",
    "DISPATCH_STARTED",
    "SHIPMENT_COMPLETED",
    "SHIPMENT_CLOSED",
    "SHIPMENT_LOST",
    "SHIPMENT_DELETED_BY_CUSTOMER",
    "STATUS_CHANGED",
    "NOTE_ADDED",
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number] | string;

export const LIFECYCLE_PIPELINE = [
    { stage: "SHIPMENT_IMPORTED", title: "Shipment Imported", status: "NEW" },
    { stage: "BROKER_ASSIGNED", title: "Awaiting Agent", status: "AWAITING_ACCEPTANCE" },
    { stage: "AGENT_OPENED", title: "Agent Opened Shipment", status: "AGENT_OPEN" },
    { stage: "BROKER_ACCEPTED_WORK", title: "Agent Working", status: "WORKING" },
    { stage: "BID_SUBMITTED", title: "Bid Submitted", status: "BID_SUBMITTED" },
    /** Broker marks this after sending a question to the customer (traffic-light). */
    { stage: "BROKER_QUESTION", title: "Broker Question", status: "BID_SUBMITTED", interactive: true },
    /** Lights from uShip/Gmail when the customer responds to that question. */
    { stage: "CUSTOMER_RESPOND", title: "Customer Respond", status: "CUSTOMER_REPLIED" },
    { stage: "CUSTOMER_ACCEPTED", title: "Customer Accepted", status: "ACCEPTED" },
    { stage: "LOAD_CREATED", title: "Load Created", status: "LOAD_CREATED" },
    { stage: "DISPATCH_STARTED", title: "Dispatch", status: "DISPATCH" },
    { stage: "SHIPMENT_COMPLETED", title: "Completed", status: "COMPLETED" },
    { stage: "SHIPMENT_CLOSED", title: "Closed", status: "CLOSED" },
    { stage: "SHIPMENT_DELETED_BY_CUSTOMER", title: "Deleted from Customer", status: "DELETED_FROM_CUSTOMER" },
] as const;

export const ACTIVE_STATUSES = [
    "NEW",
    "UNASSIGNED",
    "ASSIGNED",
    "AWAITING_ACCEPTANCE",
    "AGENT_OPEN",
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
