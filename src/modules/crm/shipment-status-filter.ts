import { SHIPMENT_STATUSES } from "../shipment/shipment.constants.js";

/**
 * Status dropdown on the Shipments list.
 * Labels match the pills in the Status column. Several stored values share
 * one pill (Waiting, Accept Green, Customer Replied), so they filter together.
 * The three the desk asks for first: Shipment Accepted, BROKER REPLY, Customer Replied.
 */
export const SHIPMENT_STATUS_FILTERS: ReadonlyArray<{
    id: string;
    label: string;
    statuses: readonly string[];
}> = [
    { id: "WORKING", label: "Shipment Accepted", statuses: ["WORKING"] },
    { id: "BROKER_REPLY", label: "BROKER REPLY", statuses: ["BROKER_REPLY"] },
    {
        id: "CUSTOMER_REPLIED",
        label: "Customer Replied",
        statuses: ["CUSTOMER_REPLIED", "CUSTOMER_RESPOND"],
    },
    { id: "NEW", label: "New", statuses: ["NEW"] },
    { id: "UNASSIGNED", label: "Unassigned", statuses: ["UNASSIGNED"] },
    { id: "WAITING", label: "Waiting", statuses: ["ASSIGNED", "AWAITING_ACCEPTANCE"] },
    { id: "AGENT_OPEN", label: "Open in uShip", statuses: ["AGENT_OPEN"] },
    { id: "FOLLOW_UP", label: "Follow Up", statuses: ["FOLLOW_UP"] },
    { id: "BID_SUBMITTED", label: "Bid Submitted", statuses: ["BID_SUBMITTED", "QUOTE_SENT"] },
    { id: "NEGOTIATION", label: "Negotiation", statuses: ["NEGOTIATION"] },
    { id: "ACCEPT_GREEN", label: "Accept Green", statuses: ["ACCEPTED", "ACCEPT_GREEN"] },
    { id: "BOOKED", label: "Booked", statuses: ["BOOKED"] },
    { id: "LOAD_CREATED", label: "Load Created", statuses: ["LOAD_CREATED"] },
    { id: "DISPATCH", label: "Dispatch", statuses: ["DISPATCH"] },
    { id: "CARRIER_ASSIGNED", label: "Assign Carrier", statuses: ["CARRIER_ASSIGNED"] },
    { id: "RATE_CON_GENERATED", label: "Rate Confirmation Generated", statuses: ["RATE_CON_GENERATED"] },
    { id: "CARRIER_ACCEPTED", label: "Carrier Accepted", statuses: ["CARRIER_ACCEPTED"] },
    { id: "PICKUP", label: "Pickup", statuses: ["PICKUP", "PICKED_UP"] },
    { id: "IN_TRANSIT", label: "In Road", statuses: ["IN_TRANSIT"] },
    { id: "DELIVERED", label: "Delivered", statuses: ["DELIVERED"] },
    { id: "POD_UPLOADED", label: "POD Uploaded", statuses: ["POD_UPLOADED"] },
    { id: "CUSTOMER_INVOICE", label: "Customer Invoice", statuses: ["CUSTOMER_INVOICE"] },
    { id: "CARRIER_PAYMENT", label: "Carrier Payment", statuses: ["CARRIER_PAYMENT"] },
    { id: "COMPLETED", label: "Completed", statuses: ["COMPLETED"] },
    { id: "WON", label: "Won", statuses: ["WON"] },
    { id: "CLOSED", label: "Closed", statuses: ["CLOSED"] },
    { id: "LOST", label: "Lost", statuses: ["LOST"] },
    {
        id: "ACCEPTED_ANOTHER_COMPANY",
        label: "Accepted another company",
        statuses: ["ACCEPTED_ANOTHER_COMPANY"],
    },
    {
        id: "DELETED_FROM_CUSTOMER",
        label: "Deleted from Customer",
        statuses: ["DELETED_FROM_CUSTOMER", "DELETED"],
    },
    {
        id: "NO_LONGER_NEEDED",
        label: "No longer needed",
        statuses: ["NO_LONGER_NEEDED"],
    },
    {
        id: "ROUND_DECLINED",
        label: "Decline",
        statuses: ["ROUND_DECLINED"],
    },
];

const FILTER_BY_ID = new Map(SHIPMENT_STATUS_FILTERS.map((row) => [row.id, row]));

export function canonicalStatusGroup(id: string | undefined | null): string {
    const key = String(id || "").trim();
    return FILTER_BY_ID.has(key) ? key : "";
}

export function shipmentStatusFilter(id: string | undefined | null): readonly string[] | null {
    const key = canonicalStatusGroup(id);
    if (!key) return null;
    return FILTER_BY_ID.get(key)!.statuses;
}

/** Default lists hide deleted rows. Choosing that filter must keep them. */
export function statusGroupIncludesDeleted(id: string | undefined | null): boolean {
    const statuses = shipmentStatusFilter(id);
    if (!statuses) return false;
    return statuses.some((status) => status === "DELETED_FROM_CUSTOMER" || status === "DELETED");
}

/**
 * Intersect the list with a status group. Call this after New / Other / Accepted
 * tabs, because those tabs clear `where.status`.
 */
export function applyStatusGroupFilter(
    where: Record<string, unknown>,
    statusGroup: string | undefined | null
): string {
    const canonical = canonicalStatusGroup(statusGroup);
    const statuses = shipmentStatusFilter(canonical);
    if (!statuses) return "";
    const and = Array.isArray(where.AND) ? [...where.AND] : [];
    and.push({ status: { in: [...statuses] } });
    where.AND = and;
    return canonical;
}

export function statusFiltersForClient(): Array<{ id: string; label: string }> {
    return SHIPMENT_STATUS_FILTERS.map((row) => ({ id: row.id, label: row.label }));
}

/** Every stored shipment status belongs to exactly one dropdown entry. */
export function uncoveredShipmentStatuses(): string[] {
    const covered = new Set(SHIPMENT_STATUS_FILTERS.flatMap((row) => [...row.statuses]));
    return SHIPMENT_STATUSES.filter((status) => !covered.has(status));
}
