/** CRM shipment statuses and timeline stages. */

export const CRM_STATUSES = [
    "NEW",
    "ASSIGNED",
    "AWAITING_ACCEPTANCE",
    "FOLLOW_UP",
    "QUOTE_SENT",
    "NEGOTIATION",
    "BOOKED",
    "PICKED_UP",
    "DELIVERED",
    "WON",
    "LOST",
    "COMPLETED",
] as const;

export type CrmShipmentStatus = (typeof CRM_STATUSES)[number];

export const ACTIVE_STATUSES: CrmShipmentStatus[] = [
    "NEW",
    "ASSIGNED",
    "AWAITING_ACCEPTANCE",
    "FOLLOW_UP",
    "QUOTE_SENT",
    "NEGOTIATION",
    "BOOKED",
    "PICKED_UP",
    "DELIVERED",
];

export const CLOSED_STATUSES: CrmShipmentStatus[] = ["WON", "LOST", "COMPLETED"];

export const TIMELINE_STAGES = [
    { stage: "IMPORTED", title: "Imported from uShip" },
    { stage: "ASSIGNED", title: "Assigned to Broker" },
    { stage: "BROKER_ACCEPTED", title: "Broker Accepted" },
    { stage: "QUOTE_SENT", title: "Quote Sent" },
    { stage: "CUSTOMER_RESPONDED", title: "Customer Responded" },
    { stage: "NEGOTIATION", title: "Negotiation" },
    { stage: "BOOKED", title: "Booked" },
    { stage: "PICKED_UP", title: "Picked Up" },
    { stage: "DELIVERED", title: "Delivered" },
    { stage: "COMPLETED", title: "Completed" },
] as const;

export type TimelineStage = (typeof TIMELINE_STAGES)[number]["stage"];

export const STATUS_LABELS: Record<string, string> = {
    NEW: "New",
    ASSIGNED: "Assigned",
    AWAITING_ACCEPTANCE: "Awaiting Acceptance",
    FOLLOW_UP: "Follow Up",
    QUOTE_SENT: "Quote Sent",
    NEGOTIATION: "Negotiation",
    BOOKED: "Booked",
    PICKED_UP: "Picked Up",
    DELIVERED: "Delivered",
    WON: "Won",
    LOST: "Lost",
    COMPLETED: "Completed",
};
