/**
 * Load-centric TMS constants.
 * Load = ShipmentLead after Customer Accepted (same permanent card).
 */

/** Full broker ops lifecycle after Create Load. */
export const LOAD_LIFECYCLE = [
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
    "CLOSED",
] as const;

export type LoadLifecycleStatus = (typeof LOAD_LIFECYCLE)[number];

export const LOAD_STATUS_LABELS: Record<string, string> = {
    LOAD_CREATED: "Create Load",
    CARRIER_ASSIGNED: "Assign Carrier",
    RATE_CON_GENERATED: "Rate Confirmation Generated",
    CARRIER_ACCEPTED: "Carrier Accepted",
    PICKUP: "Pickup",
    IN_TRANSIT: "In Transit",
    DELIVERED: "Delivered",
    POD_UPLOADED: "POD Uploaded",
    CUSTOMER_INVOICE: "Customer Invoice",
    CARRIER_PAYMENT: "Carrier Payment",
    CLOSED: "Closed",
    DISPATCH: "Dispatch",
    COMPLETED: "Completed",
};

/** Tracking progress steps (Tracking tab). */
export const TRACKING_STEPS = [
    { id: "ASSIGNED", title: "Assigned" },
    { id: "DISPATCHED", title: "Dispatched" },
    { id: "LOADED", title: "Loaded" },
    { id: "IN_TRANSIT", title: "In Transit" },
    { id: "DELIVERED", title: "Delivered" },
    { id: "COMPLETED", title: "Completed" },
] as const;

export const LOAD_DOC_TYPES = [
    "RATE_CONFIRMATION",
    "BOL",
    "POD",
    "CARRIER_PACKET",
    "INSURANCE",
    "W9",
    "NOA",
    "CUSTOMER_INVOICE",
    "CARRIER_INVOICE",
    "DISPATCH_SHEET",
    "LOAD_SUMMARY",
    "ATTACHMENT",
] as const;

export type LoadDocType = (typeof LOAD_DOC_TYPES)[number];

export const LOAD_DOC_TYPE_LABELS: Record<string, string> = {
    RATE_CONFIRMATION: "Rate Confirmation",
    BOL: "Bill of Lading",
    POD: "Proof of Delivery",
    CARRIER_PACKET: "Carrier Packet",
    INSURANCE: "Insurance",
    W9: "W9",
    NOA: "NOA",
    CUSTOMER_INVOICE: "Customer Invoice",
    CARRIER_INVOICE: "Carrier Invoice",
    DISPATCH_SHEET: "Dispatch Sheet",
    LOAD_SUMMARY: "Load Summary",
    ATTACHMENT: "Attachment",
};

export const LOAD_DOC_CHANGE_REASONS = [
    "GENERATED",
    "BROKER_EDITED",
    "CUSTOMER_REQUESTED",
    "FINAL_SIGNED",
    "UPLOADED",
    "REPLACED",
    "ARCHIVED",
] as const;

export const LOAD_DOC_CHANGE_LABELS: Record<string, string> = {
    GENERATED: "Generated",
    BROKER_EDITED: "Broker Edited",
    CUSTOMER_REQUESTED: "Customer Requested Changes",
    FINAL_SIGNED: "Final Signed",
    UPLOADED: "Uploaded",
    REPLACED: "Replaced",
    ARCHIVED: "Archived",
};

/** Domain events for Load document / ops automation. */
export const LOAD_DOMAIN_EVENTS = [
    "CARRIER_ASSIGNED",
    "RATE_CONFIRMATION_GENERATED",
    "RATE_CONFIRMATION_EDITED",
    "RATE_CONFIRMATION_SENT",
    "CARRIER_ACCEPTED",
    "BOL_GENERATED",
    "BOL_EDITED",
    "PICKUP_MARKED",
    "IN_TRANSIT_MARKED",
    "DELIVERED_MARKED",
    "POD_UPLOADED",
    "CUSTOMER_INVOICE_GENERATED",
    "CUSTOMER_INVOICE_SENT",
    "CARRIER_INVOICE_GENERATED",
    "CARRIER_PAID",
    "LOAD_CLOSED",
    "DOCUMENT_GENERATED",
    "DOCUMENT_EDITED",
    "DOCUMENT_SENT",
    "DOCUMENT_ARCHIVED",
] as const;

export const LOAD_PIPELINE = [
    { stage: "CUSTOMER_ACCEPTED", title: "Customer Accepted", status: "ACCEPTED" },
    { stage: "LOAD_CREATED", title: "Load Created", status: "LOAD_CREATED" },
    { stage: "CARRIER_ASSIGNED", title: "Carrier Assigned", status: "CARRIER_ASSIGNED" },
    { stage: "RATE_CONFIRMATION_GENERATED", title: "Rate Confirmation Generated", status: "RATE_CON_GENERATED" },
    { stage: "CARRIER_ACCEPTED", title: "Carrier Accepted", status: "CARRIER_ACCEPTED" },
    { stage: "PICKUP_MARKED", title: "Pickup", status: "PICKUP" },
    { stage: "IN_TRANSIT_MARKED", title: "In Transit", status: "IN_TRANSIT" },
    { stage: "DELIVERED_MARKED", title: "Delivered", status: "DELIVERED" },
    { stage: "POD_UPLOADED", title: "POD Uploaded", status: "POD_UPLOADED" },
    { stage: "CUSTOMER_INVOICE_GENERATED", title: "Customer Invoice", status: "CUSTOMER_INVOICE" },
    { stage: "CARRIER_PAID", title: "Carrier Payment", status: "CARRIER_PAYMENT" },
    { stage: "LOAD_CLOSED", title: "Closed", status: "CLOSED" },
] as const;
