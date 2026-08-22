/**
 * Deterministic lane normalization for Phase 5A market rate engine.
 *
 * Rules:
 * - ZIP: digits only, first 5 digits (ZIP5). No fuzzy matching.
 * - City: uppercase, trim, collapse whitespace, strip punctuation except spaces.
 * - State: 2-letter USPS abbreviation (full names mapped deterministically).
 * - Lane identity prefers ZIP5 pair, else city|state pair.
 * - Region: ZIP3 prefix when ZIP exists, else state code.
 */

const US_STATE_TO_ABBR: Record<string, string> = {
    ALABAMA: "AL",
    ALASKA: "AK",
    ARIZONA: "AZ",
    ARKANSAS: "AR",
    CALIFORNIA: "CA",
    COLORADO: "CO",
    CONNECTICUT: "CT",
    DELAWARE: "DE",
    "DISTRICT OF COLUMBIA": "DC",
    FLORIDA: "FL",
    GEORGIA: "GA",
    HAWAII: "HI",
    IDAHO: "ID",
    ILLINOIS: "IL",
    INDIANA: "IN",
    IOWA: "IA",
    KANSAS: "KS",
    KENTUCKY: "KY",
    LOUISIANA: "LA",
    MAINE: "ME",
    MARYLAND: "MD",
    MASSACHUSETTS: "MA",
    MICHIGAN: "MI",
    MINNESOTA: "MN",
    MISSISSIPPI: "MS",
    MISSOURI: "MO",
    MONTANA: "MT",
    NEBRASKA: "NE",
    NEVADA: "NV",
    "NEW HAMPSHIRE": "NH",
    "NEW JERSEY": "NJ",
    "NEW MEXICO": "NM",
    "NEW YORK": "NY",
    "NORTH CAROLINA": "NC",
    "NORTH DAKOTA": "ND",
    OHIO: "OH",
    OKLAHOMA: "OK",
    OREGON: "OR",
    PENNSYLVANIA: "PA",
    "RHODE ISLAND": "RI",
    "SOUTH CAROLINA": "SC",
    "SOUTH DAKOTA": "SD",
    TENNESSEE: "TN",
    TEXAS: "TX",
    UTAH: "UT",
    VERMONT: "VT",
    VIRGINIA: "VA",
    WASHINGTON: "WA",
    "WEST VIRGINIA": "WV",
    WISCONSIN: "WI",
    WYOMING: "WY",
};

function collapseWhitespace(s: string): string {
    return s.replace(/\s+/g, " ").trim();
}

export function normalizeZip(input: string | null | undefined): string | null {
    const digits = String(input || "").replace(/\D/g, "");
    if (digits.length < 5) return null;
    return digits.slice(0, 5);
}

export function normalizeCity(input: string | null | undefined): string | null {
    const s = collapseWhitespace(
        String(input || "")
            .toUpperCase()
            .replace(/[^A-Z0-9\s]/g, " ")
    );
    return s || null;
}

export function normalizeState(input: string | null | undefined): string | null {
    const raw = collapseWhitespace(String(input || "").toUpperCase().replace(/[^A-Z\s]/g, " "));
    if (!raw) return null;
    if (/^[A-Z]{2}$/.test(raw)) return raw;
    return US_STATE_TO_ABBR[raw] || null;
}

export function formatLaneLabel(
    city: string | null | undefined,
    state: string | null | undefined
): string {
    const c = normalizeCity(city);
    const st = normalizeState(state);
    if (c && st) return `${c}, ${st}`;
    if (c) return c;
    if (st) return st;
    return "—";
}

export function laneZipKey(originZip: string | null, destinationZip: string | null): string | null {
    if (!originZip || !destinationZip) return null;
    return `${originZip}|${destinationZip}`;
}

export function laneCityStateKey(
    originCity: string | null,
    originState: string | null,
    destinationCity: string | null,
    destinationState: string | null
): string | null {
    if (!originCity || !originState || !destinationCity || !destinationState) return null;
    return `${originCity}|${originState}|${destinationCity}|${destinationState}`;
}

export function regionKey(zip: string | null, state: string | null): string | null {
    if (zip && zip.length >= 3) return zip.slice(0, 3);
    if (state) return state;
    return null;
}

export function regionalLaneKey(
    originZip: string | null,
    originState: string | null,
    destinationZip: string | null,
    destinationState: string | null
): string | null {
    const o = regionKey(originZip, originState);
    const d = regionKey(destinationZip, destinationState);
    if (!o || !d) return null;
    return `${o}|${d}`;
}

export type NormalizedLane = {
    origin: string;
    destination: string;
    originZip: string | null;
    destinationZip: string | null;
    originCity: string | null;
    originState: string | null;
    destinationCity: string | null;
    destinationState: string | null;
    zipLaneKey: string | null;
    cityStateLaneKey: string | null;
    regionalLaneKey: string | null;
};

export function normalizeLane(input: {
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
}): NormalizedLane {
    const originZip = normalizeZip(input.originZip ?? input.pickupZip);
    const destinationZip = normalizeZip(input.destinationZip ?? input.deliveryZip);

    let originCity = normalizeCity(input.originCity ?? input.pickupCity);
    let originState = normalizeState(input.originState ?? input.pickupState);
    let destinationCity = normalizeCity(input.destinationCity ?? input.deliveryCity);
    let destinationState = normalizeState(input.destinationState ?? input.deliveryState);

    if (!originCity && input.origin) {
        const parsed = parseCityState(input.origin);
        originCity = parsed.city;
        originState = originState || parsed.state;
    }
    if (!destinationCity && input.destination) {
        const parsed = parseCityState(input.destination);
        destinationCity = parsed.city;
        destinationState = destinationState || parsed.state;
    }

    return {
        origin: formatLaneLabel(originCity, originState),
        destination: formatLaneLabel(destinationCity, destinationState),
        originZip,
        destinationZip,
        originCity,
        originState,
        destinationCity,
        destinationState,
        zipLaneKey: laneZipKey(originZip, destinationZip),
        cityStateLaneKey: laneCityStateKey(originCity, originState, destinationCity, destinationState),
        regionalLaneKey: regionalLaneKey(originZip, originState, destinationZip, destinationState),
    };
}

function parseCityState(text: string): { city: string | null; state: string | null } {
    const parts = String(text || "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
    if (parts.length >= 2) {
        return {
            city: normalizeCity(parts.slice(0, -1).join(", ")),
            state: normalizeState(parts[parts.length - 1]),
        };
    }
    return { city: normalizeCity(text), state: null };
}
