import {
    EXCLUDED_SHIPMENT_STATUSES,
    MAX_VALID_RATE,
    MIN_VALID_RATE,
} from "./constants.js";
import { normalizeEquipment } from "./equipment-normalize.js";
import { formatLaneLabel, normalizeLane, normalizeZip } from "./lane-normalize.js";
import type { HistoricalRateRecord } from "./types.js";

export type ShipmentLeadRateRow = {
    shipmentLeadId: string;
    loadNumber: string | null;
    greenOsShipmentId: string | null;
    pickupCity: string | null;
    pickupState: string | null;
    pickupZip: string | null;
    deliveryCity: string | null;
    deliveryState: string | null;
    deliveryZip: string | null;
    equipment: string | null;
    miles: number | null;
    weight: string | null;
    carrierRate: number | null;
    carrierProfileId: string | null;
    pickupFrom: Date | null;
    deliveryFrom: Date | null;
    status: string;
};

/**
 * Historical rate source (Phase 5A):
 * - Primary: ShipmentLead.carrierRate (actual carrier / Rate Con flat rate stored on the card)
 * - Requires miles > 0 on the same ShipmentLead row for RPM
 * - RC PDF extractions are NOT duplicated here; carrierRate is the aggregate field.
 */
export function extractHistoricalRate(row: ShipmentLeadRateRow): number | null {
    const rate = row.carrierRate;
    if (rate == null || !Number.isFinite(rate)) return null;
    if (rate < MIN_VALID_RATE || rate > MAX_VALID_RATE) return null;
    return rate;
}

export function isValidHistoricalRow(row: ShipmentLeadRateRow): boolean {
    const status = String(row.status || "").toUpperCase();
    if (EXCLUDED_SHIPMENT_STATUSES.includes(status as (typeof EXCLUDED_SHIPMENT_STATUSES)[number])) {
        return false;
    }
    const rate = extractHistoricalRate(row);
    if (rate == null) return false;
    const miles = row.miles;
    if (miles == null || !Number.isFinite(miles) || miles <= 0) return false;
    const lane = normalizeLane({
        pickupCity: row.pickupCity ?? undefined,
        pickupState: row.pickupState ?? undefined,
        pickupZip: row.pickupZip ?? undefined,
        deliveryCity: row.deliveryCity ?? undefined,
        deliveryState: row.deliveryState ?? undefined,
        deliveryZip: row.deliveryZip ?? undefined,
    });
    if (!lane.originCity || !lane.destinationCity) return false;
    return true;
}

export function mapToHistoricalRecord(row: ShipmentLeadRateRow): HistoricalRateRecord | null {
    if (!isValidHistoricalRow(row)) return null;
    const rate = extractHistoricalRate(row)!;
    const miles = Number(row.miles);
    const lane = normalizeLane({
        pickupCity: row.pickupCity ?? undefined,
        pickupState: row.pickupState ?? undefined,
        pickupZip: row.pickupZip ?? undefined,
        deliveryCity: row.deliveryCity ?? undefined,
        deliveryState: row.deliveryState ?? undefined,
        deliveryZip: row.deliveryZip ?? undefined,
    });
    const equipmentCategory = normalizeEquipment(row.equipment);
    return {
        shipmentId: row.shipmentLeadId,
        loadNumber: row.loadNumber || row.greenOsShipmentId,
        origin: lane.origin,
        destination: lane.destination,
        originZip: lane.originZip,
        destinationZip: lane.destinationZip,
        originCity: lane.originCity,
        originState: lane.originState,
        destinationCity: lane.destinationCity,
        destinationState: lane.destinationState,
        originRegion: lane.originZip ? lane.originZip.slice(0, 3) : lane.originState,
        destinationRegion: lane.destinationZip
            ? lane.destinationZip.slice(0, 3)
            : lane.destinationState,
        equipment: row.equipment,
        equipmentCategory,
        miles,
        weight: row.weight,
        rate,
        rpm: rate / miles,
        pickupDate: row.pickupFrom ? row.pickupFrom.toISOString() : null,
        deliveryDate: row.deliveryFrom ? row.deliveryFrom.toISOString() : null,
        carrierId: row.carrierProfileId,
        status: row.status,
    };
}

export function parseMoneyQuote(input: unknown): number | null {
    if (input == null || input === "") return null;
    const n = typeof input === "number" ? input : Number(String(input).replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

export { normalizeZip, formatLaneLabel };
