export type ArrivalHandoff = {
    shipmentId: string;
    brokerId: string;
    at: Date | string;
};

/** One row per shipment and broker. `logs` must be newest first. */
export function latestHandoffs<T extends ArrivalHandoff>(logs: T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const log of logs) {
        if (!log.shipmentId || !log.brokerId) continue;
        const key = `${log.shipmentId}\0${log.brokerId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(log);
    }
    return out;
}

export type BrokerArrivalSummary = {
    brokerId: string | null;
    name: string;
    count: number;
    lastReceivedAt: string | null;
};

/** Who received how many, and the latest time, for this New or Other list. */
export function brokerArrivalSummary(
    rows: Array<{ brokerId: string | null; at: Date | string | null }>,
    nameOf: (brokerId: string | null) => string
): BrokerArrivalSummary[] {
    const map = new Map<string, BrokerArrivalSummary>();
    for (const row of rows) {
        const key = row.brokerId || "";
        let item = map.get(key);
        if (!item) {
            item = {
                brokerId: row.brokerId,
                name: nameOf(row.brokerId) || "Unassigned",
                count: 0,
                lastReceivedAt: null,
            };
            map.set(key, item);
        }
        item.count += 1;
        if (!row.at) continue;
        const iso = new Date(row.at).toISOString();
        if (Number.isNaN(new Date(iso).getTime())) continue;
        if (!item.lastReceivedAt || iso > item.lastReceivedAt) item.lastReceivedAt = iso;
    }
    return [...map.values()].sort(
        (a, b) => b.count - a.count || a.name.localeCompare(b.name)
    );
}
