import { normalizeEquipment } from "./equipment-normalize.js";
import { normalizeLane } from "./lane-normalize.js";
import type { ComparisonLevel, HistoricalRateRecord } from "./types.js";

export type ComparableMatch = {
    level: ComparisonLevel;
    records: HistoricalRateRecord[];
};

export type QueryLaneContext = ReturnType<typeof normalizeLane> & {
    equipmentCategory: string;
};

export function buildQueryContext(input: {
    origin?: string;
    destination?: string;
    originZip?: string;
    destinationZip?: string;
    originCity?: string;
    originState?: string;
    destinationCity?: string;
    destinationState?: string;
    pickupCity?: string;
    pickupState?: string;
    deliveryCity?: string;
    deliveryState?: string;
    pickupZip?: string;
    deliveryZip?: string;
    equipment?: string;
}): QueryLaneContext {
    const lane = normalizeLane(input);
    return {
        ...lane,
        equipmentCategory: normalizeEquipment(input.equipment),
    };
}

function sameEquipment(query: QueryLaneContext, record: HistoricalRateRecord): boolean {
    return query.equipmentCategory === record.equipmentCategory;
}

function matchExactZip(query: QueryLaneContext, record: HistoricalRateRecord): boolean {
    if (!query.zipLaneKey || !record.originZip || !record.destinationZip) return false;
    const recordKey = `${record.originZip}|${record.destinationZip}`;
    return query.zipLaneKey === recordKey && sameEquipment(query, record);
}

function matchLaneEquipment(query: QueryLaneContext, record: HistoricalRateRecord): boolean {
    if (!query.cityStateLaneKey) return false;
    const recordKey = `${record.originCity}|${record.originState}|${record.destinationCity}|${record.destinationState}`;
    return query.cityStateLaneKey === recordKey && sameEquipment(query, record);
}

function matchRegional(query: QueryLaneContext, record: HistoricalRateRecord): boolean {
    if (!query.regionalLaneKey) return false;
    const oReg = query.originZip ? query.originZip.slice(0, 3) : query.originState;
    const dReg = query.destinationZip ? query.destinationZip.slice(0, 3) : query.destinationState;
    if (!oReg || !dReg) return false;
    const recordKey = `${record.originRegion}|${record.destinationRegion}`;
    return `${oReg}|${dReg}` === recordKey && sameEquipment(query, record);
}

/**
 * Comparable matching order (deterministic):
 * 1. EXACT_ZIP_LANE — origin ZIP5 → destination ZIP5 + equipment category
 * 2. LANE_EQUIPMENT — normalized city/state lane + equipment category
 * 3. REGIONAL — ZIP3 or state region pair + equipment category
 */
export function findComparables(
    query: QueryLaneContext,
    dataset: HistoricalRateRecord[],
    excludeShipmentId?: string
): ComparableMatch | null {
    const pool = excludeShipmentId
        ? dataset.filter((r) => r.shipmentId !== excludeShipmentId)
        : dataset;

    const levels: Array<{ level: ComparisonLevel; match: (r: HistoricalRateRecord) => boolean }> =
        [
            { level: "EXACT_ZIP_LANE", match: (r) => matchExactZip(query, r) },
            { level: "LANE_EQUIPMENT", match: (r) => matchLaneEquipment(query, r) },
            { level: "REGIONAL", match: (r) => matchRegional(query, r) },
        ];

    for (const { level, match } of levels) {
        const records = pool.filter(match);
        if (records.length) return { level, records };
    }

    return null;
}

export const _comparablesTestUtils = { findComparables, buildQueryContext };
