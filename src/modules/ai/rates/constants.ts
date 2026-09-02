/**
 * Phase 5A — configurable thresholds (not LLM-controlled).
 */

/** Minimum comparable shipments for each confidence tier. */
export const CONFIDENCE_THRESHOLDS = {
    HIGH: 10,
    MEDIUM: 3,
    LOW: 1,
} as const;

/** Shipments older than this window receive reduced recency weight. */
export const RECENCY_WINDOW_MONTHS = 24;

/** When the newest comparable is older than this, confidence is downgraded one level. */
export const RECENCY_STALE_MONTHS = 12;

/** Recency weight multiplier for shipments outside RECENCY_WINDOW_MONTHS. */
export const RECENCY_OLD_WEIGHT = 0.5;

/** Comparison-level weights (deterministic, documented). */
export const COMPARISON_LEVEL_WEIGHT = {
    EXACT_ZIP_LANE: 1.0,
    LANE_EQUIPMENT: 0.85,
    REGIONAL: 0.65,
} as const;

/** Max historical rows fetched per quote (ACL-scoped). */
export const HISTORICAL_FETCH_LIMIT = 10000;

/** Minimum valid carrier rate (USD). */
export const MIN_VALID_RATE = 50;

/** Maximum valid carrier rate (USD) — corrupt-data guard. */
export const MAX_VALID_RATE = 50000;

/** Statuses excluded from historical rate dataset (cancelled / lost / deleted). */
export const EXCLUDED_SHIPMENT_STATUSES = [
    "LOST",
    "ACCEPTED_ANOTHER_COMPANY",
    "DELETED_FROM_CUSTOMER",
    "DELETED",
    "CANCELLED",
    "CANCELED",
] as const;

/** Target rate formula: median (P50) of comparable historical rates. */
export const TARGET_RATE_PERCENTILE = 0.5;
