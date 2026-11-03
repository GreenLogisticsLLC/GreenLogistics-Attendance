export type ArrivalCounts = { newShipments: number; otherShipments: number };

/** How many distinct shipments arrived to each person as New or as Other. */
export function countShipmentArrivals(
    logs: Array<{
        userId: string | null;
        eventType: string;
        shipmentId: string | null;
        logId: string;
    }>
): Map<string, ArrivalCounts> {
    const seen = new Set<string>();
    const totals = new Map<string, ArrivalCounts>();
    for (const log of logs) {
        if (!log.userId) continue;
        const kind =
            log.eventType === "ASSIGNED" ? "new" : log.eventType === "REASSIGNED" ? "other" : null;
        if (!kind) continue;
        const key = `${log.userId}:${kind}:${log.shipmentId || log.logId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const row = totals.get(log.userId) || { newShipments: 0, otherShipments: 0 };
        if (kind === "new") row.newShipments += 1;
        else row.otherShipments += 1;
        totals.set(log.userId, row);
    }
    return totals;
}

export function arrivalCountsFor(
    totals: Map<string, ArrivalCounts>,
    userId: string
): ArrivalCounts {
    return totals.get(userId) || { newShipments: 0, otherShipments: 0 };
}
