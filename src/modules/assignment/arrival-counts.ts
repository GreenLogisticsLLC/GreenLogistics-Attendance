export type ArrivalCounts = {
    newShipments: number;
    newAccepted: number;
    newDeclined: number;
    newWaiting: number;
    otherShipments: number;
};

const EMPTY: ArrivalCounts = {
    newShipments: 0,
    newAccepted: 0,
    newDeclined: 0,
    newWaiting: 0,
    otherShipments: 0,
};

export type ArrivalLead = {
    assignedBrokerId: string | null;
    acceptedAt: Date | string | null;
};

/**
 * Distinct live shipments that arrived to each person.
 * New is an ASSIGNED handoff. Other is a REASSIGNED handoff.
 * Of the New ones: Accept means this person kept it, Declined means it left them, Waiting means it is still with them and not accepted.
 */
export function summarizeShipmentArrivals(input: {
    logs: Array<{ userId: string | null; eventType: string; shipmentId: string | null }>;
    leads: Map<string, ArrivalLead>;
}): Map<string, ArrivalCounts> {
    const kinds = new Map<string, Map<string, Set<"new" | "other">>>();
    for (const log of input.logs) {
        if (!log.userId || !log.shipmentId || !input.leads.has(log.shipmentId)) continue;
        const kind = log.eventType === "REASSIGNED" ? "other" : log.eventType === "ASSIGNED" ? "new" : null;
        if (!kind) continue;
        let byShipment = kinds.get(log.userId);
        if (!byShipment) {
            byShipment = new Map();
            kinds.set(log.userId, byShipment);
        }
        let set = byShipment.get(log.shipmentId);
        if (!set) {
            set = new Set();
            byShipment.set(log.shipmentId, set);
        }
        set.add(kind);
    }
    const totals = new Map<string, ArrivalCounts>();
    for (const [userId, byShipment] of kinds) {
        const row = { ...EMPTY };
        for (const [shipmentId, set] of byShipment) {
            const lead = input.leads.get(shipmentId);
            if (!lead) continue;
            if (set.has("other")) row.otherShipments += 1;
            if (!set.has("new")) continue;
            row.newShipments += 1;
            const kept = lead.assignedBrokerId === userId;
            const accepted = Boolean(lead.acceptedAt) && kept;
            if (accepted) row.newAccepted += 1;
            else if (kept) row.newWaiting += 1;
            else row.newDeclined += 1;
        }
        totals.set(userId, row);
    }
    return totals;
}

export function arrivalCountsFor(totals: Map<string, ArrivalCounts>, userId: string): ArrivalCounts {
    return totals.get(userId) || { ...EMPTY };
}
