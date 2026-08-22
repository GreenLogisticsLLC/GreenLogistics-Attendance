import type { RateStatistics } from "./types.js";

function sortedCopy(values: number[]): number[] {
    return [...values].sort((a, b) => a - b);
}

/** Linear interpolation percentile (deterministic). */
export function percentile(values: number[], p: number): number {
    if (!values.length) return NaN;
    const sorted = sortedCopy(values);
    if (sorted.length === 1) return sorted[0];
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function computeRateStatistics(values: number[]): RateStatistics | null {
    if (!values.length) return null;
    const sorted = sortedCopy(values);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
        count: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        average: sum / sorted.length,
        median: percentile(sorted, 0.5),
        p25: percentile(sorted, 0.25),
        p75: percentile(sorted, 0.75),
    };
}

export function roundDisplay(n: number, decimals = 2): number {
    const f = 10 ** decimals;
    return Math.round(n * f) / f;
}

export function roundRateStats(stats: RateStatistics): RateStatistics {
    return {
        count: stats.count,
        min: roundDisplay(stats.min),
        max: roundDisplay(stats.max),
        average: roundDisplay(stats.average),
        median: roundDisplay(stats.median),
        p25: roundDisplay(stats.p25),
        p75: roundDisplay(stats.p75),
    };
}

export const _statisticsTestUtils = { percentile, computeRateStatistics };
