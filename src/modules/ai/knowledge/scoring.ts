/** Deterministic ranking scores for Phase 3 structured search. */

export const SCORE = {
    EXACT_MC_DOT_LOAD: 0.99,
    EXACT_ID: 0.97,
    EXACT_NAME: 0.9,
    EXACT_FIELD: 0.88,
    KEYWORD: 0.65,
    FILENAME: 0.6,
    GENERAL_TEXT: 0.4,
} as const;

export function clampScore(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}
