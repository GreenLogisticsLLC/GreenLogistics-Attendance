import {
    CONFIDENCE_THRESHOLDS,
    RECENCY_STALE_MONTHS,
    RECENCY_WINDOW_MONTHS,
    TARGET_RATE_PERCENTILE,
} from "./constants.js";
import { percentile } from "./statistics.js";
import type { ConfidenceLevel, HistoricalRateRecord } from "./types.js";

export function confidenceFromSampleSize(count: number): ConfidenceLevel | null {
    if (count >= CONFIDENCE_THRESHOLDS.HIGH) return "HIGH";
    if (count >= CONFIDENCE_THRESHOLDS.MEDIUM) return "MEDIUM";
    if (count >= CONFIDENCE_THRESHOLDS.LOW) return "LOW";
    return null;
}

export function monthsBetween(later: Date, earlier: Date): number {
    const ms = later.getTime() - earlier.getTime();
    return ms / (1000 * 60 * 60 * 24 * 30.4375);
}

export function downgradeConfidence(level: ConfidenceLevel): ConfidenceLevel {
    if (level === "HIGH") return "MEDIUM";
    if (level === "MEDIUM") return "LOW";
    return "LOW";
}

export function applyRecencyConfidence(
    base: ConfidenceLevel | null,
    records: HistoricalRateRecord[],
    now = new Date()
): { confidence: ConfidenceLevel | null; recencyNote: string | null } {
    if (!base || !records.length) return { confidence: base, recencyNote: null };

    const dates = records
        .map((r) => (r.pickupDate ? new Date(r.pickupDate) : null))
        .filter((d): d is Date => d != null && !Number.isNaN(d.getTime()));

    if (!dates.length) return { confidence: base, recencyNote: null };

    const latest = new Date(Math.max(...dates.map((d) => d.getTime())));
    const staleMonths = monthsBetween(now, latest);

    if (staleMonths > RECENCY_STALE_MONTHS) {
        return {
            confidence: downgradeConfidence(base),
            recencyNote: `Latest comparable shipment: ${Math.round(staleMonths)} months ago`,
        };
    }

    const outsideWindow = dates.filter(
        (d) => monthsBetween(now, d) > RECENCY_WINDOW_MONTHS
    ).length;
    if (outsideWindow === dates.length) {
        return {
            confidence: downgradeConfidence(base),
            recencyNote: `All comparables are older than ${RECENCY_WINDOW_MONTHS} months`,
        };
    }

    return { confidence: base, recencyNote: null };
}

/** Target = median (P50) of comparable historical rates — deterministic formula. */
export function computeTargetRate(rates: number[]): number | null {
    if (!rates.length) return null;
    return percentile(rates, TARGET_RATE_PERCENTILE);
}

export function computeTargetFromRpm(medianRpm: number, miles: number): number {
    return medianRpm * miles;
}

export const _confidenceTestUtils = {
    confidenceFromSampleSize,
    applyRecencyConfidence,
    computeTargetRate,
};
