/**
 * Deterministic equipment normalization for Phase 5A.
 *
 * Categories: DRY_VAN | REEFER | FLATBED | STEP_DECK | POWER_ONLY | OTHER
 *
 * Mapping rules (case/whitespace/punctuation insensitive):
 * - DRY_VAN: dry van, van, dv, dryvan, 53 van, box van, enclosed
 * - REEFER: reefer, refrigerated, rf, temp controlled, reefer van
 * - FLATBED: flatbed, flat bed, fb, flat
 * - STEP_DECK: step deck, stepdeck, step-deck
 * - POWER_ONLY: power only, power-only
 * - OTHER: unmatched values and null
 */

export type EquipmentCategory =
    | "DRY_VAN"
    | "REEFER"
    | "FLATBED"
    | "STEP_DECK"
    | "POWER_ONLY"
    | "OTHER";

function normalizeToken(input: string | null | undefined): string {
    return String(input || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

const DRY_VAN_PATTERNS = [
    "DRY VAN",
    "DRYVAN",
    "VAN",
    "DV",
    "53 VAN",
    "BOX VAN",
    "ENCLOSED",
    "DRY VAN 53",
];

const REEFER_PATTERNS = ["REEFER", "REFRIGERATED", "RF", "TEMP CONTROLLED", "REEFER VAN", "REFRIG"];

const FLATBED_PATTERNS = ["FLATBED", "FLAT BED", "FB", "FLAT"];

const STEP_DECK_PATTERNS = ["STEP DECK", "STEPDECK", "STEP-DECK"];

const POWER_ONLY_PATTERNS = ["POWER ONLY", "POWER-ONLY", "POWERONLY"];

function matchesAny(token: string, patterns: string[]): boolean {
    return patterns.some((p) => token === p || token.includes(p));
}

export function normalizeEquipment(input: string | null | undefined): EquipmentCategory {
    const token = normalizeToken(input);
    if (!token) return "OTHER";
    if (matchesAny(token, DRY_VAN_PATTERNS)) return "DRY_VAN";
    if (matchesAny(token, REEFER_PATTERNS)) return "REEFER";
    if (matchesAny(token, FLATBED_PATTERNS)) return "FLATBED";
    if (matchesAny(token, STEP_DECK_PATTERNS)) return "STEP_DECK";
    if (matchesAny(token, POWER_ONLY_PATTERNS)) return "POWER_ONLY";
    return "OTHER";
}

export function equipmentCategoriesEqual(
    a: string | null | undefined,
    b: string | null | undefined
): boolean {
    return normalizeEquipment(a) === normalizeEquipment(b);
}
