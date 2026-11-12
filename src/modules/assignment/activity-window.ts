/** Brokers and Team Leads must click or type in GreenOS at least this often to receive New and Other shipments. */
export const GREEN_OS_ACTIVITY_MS = 20 * 60 * 1000;

const ACTIVITY_ROLES = new Set(["Broker", "Team Lead"]);

/**
 * Broker / Team Lead must have a GreenOS click within 20 minutes.
 * Null activity = never signed in / never clicked → not eligible (In Office alone is not enough).
 * Owner "Set In Office" does not bypass this — idle staff stay out of New and Other.
 */
export function receivesNewShipments(
    role: string,
    activityAt: Date | null | undefined,
    now: Date
): boolean {
    if (!ACTIVITY_ROLES.has(role)) return true;
    if (!activityAt) return false;
    return now.getTime() - activityAt.getTime() < GREEN_OS_ACTIVITY_MS;
}
