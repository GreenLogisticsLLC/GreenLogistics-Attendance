/** CRM shipment statuses and timeline stages — backed by Shipment Aggregate (Sprint A). */

export {
    ACTIVE_STATUSES,
    STATUS_LABELS,
    SHIPMENT_STATUSES as CRM_STATUSES,
    LIFECYCLE_PIPELINE,
    type ShipmentStatus as CrmShipmentStatus,
} from "../shipment/shipment.constants.js";

/** Waiting for a broker In Office (Assignment Engine). */
export const UNASSIGNED_STATUSES: string[] = ["NEW", "UNASSIGNED"];

export const CLOSED_STATUSES: string[] = ["WON", "LOST", "COMPLETED", "CLOSED"];

/** @deprecated Prefer LIFECYCLE_PIPELINE from Domain Events. Kept for older UI. */
export const TIMELINE_STAGES = [
    { stage: "IMPORTED", title: "Imported from uShip" },
    { stage: "ASSIGNED", title: "Assigned to Broker" },
    { stage: "BROKER_ACCEPTED", title: "Broker Accepted Shipment" },
    { stage: "BID_SUBMITTED", title: "Bid Submitted" },
    { stage: "CUSTOMER_REPLIED", title: "Customer Replied" },
    { stage: "CUSTOMER_ACCEPTED", title: "Customer Accepted" },
    { stage: "LOAD_CREATED", title: "Load Created" },
] as const;

export type TimelineStage = (typeof TIMELINE_STAGES)[number]["stage"];
