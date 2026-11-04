/**
 * Shipment board tabs.
 * Other stays for loads a broker did not take.
 * A generated Load (customer approved, Load Created, or any later load number)
 * belongs only on the Load Created tab.
 */

export type ShipmentAssignmentKind = "new" | "other" | "accepted" | "loads";

const TERMINAL = ["DELETED_FROM_CUSTOMER", "LOST", "ACCEPTED_ANOTHER_COMPANY"] as const;

const WAITING = ["NEW", "UNASSIGNED", "ASSIGNED", "AWAITING_ACCEPTANCE", "AGENT_OPEN"] as const;

export function isGeneratedLoad(row: {
    status?: string | null;
    loadNumber?: string | null;
}): boolean {
    const status = String(row.status || "");
    if ((TERMINAL as readonly string[]).includes(status)) return false;
    if (status === "LOAD_CREATED") return true;
    return Boolean(String(row.loadNumber || "").trim());
}

/** Prisma match for the Load Created tab. */
export function generatedLoadWhere(): Record<string, unknown> {
    return {
        AND: [
            {
                OR: [
                    { status: "LOAD_CREATED" },
                    { AND: [{ loadNumber: { not: null } }, { NOT: { loadNumber: "" } }] },
                ],
            },
            { status: { notIn: [...TERMINAL, "VOIDED"] } },
        ],
    };
}

/** Keep generated loads out of New, Other, and Accepted. */
export function notGeneratedLoadWhere(): Record<string, unknown> {
    return {
        NOT: {
            OR: [
                { status: "LOAD_CREATED" },
                { AND: [{ loadNumber: { not: null } }, { NOT: { loadNumber: "" } }] },
            ],
        },
    };
}

export function isShipmentAssignmentKind(value: unknown): value is ShipmentAssignmentKind {
    return value === "new" || value === "other" || value === "accepted" || value === "loads";
}

export { WAITING as SHIPMENT_WAITING_STATUSES, TERMINAL as SHIPMENT_TAB_TERMINAL };
