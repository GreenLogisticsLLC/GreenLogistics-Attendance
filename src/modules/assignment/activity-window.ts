/** Brokers and Team Leads must click or type in GreenOS at least this often to receive New and Other shipments. */
export const GREEN_OS_ACTIVITY_MS = 20 * 60 * 1000;

const ACTIVITY_ROLES = new Set(["Broker", "Team Lead"]);

/**
 * Null activity means this account has not opened the tracked client yet — keep the old In Office rule.
 * Once a click is recorded, 20 minutes without another click removes them from New and Other assignment.
 */
export function receivesNewShipments(
    role: string,
    activityAt: Date | null | undefined,
    now: Date
): boolean {
    if (!ACTIVITY_ROLES.has(role)) return true;
    if (!activityAt) return true;
    return now.getTime() - activityAt.getTime() < GREEN_OS_ACTIVITY_MS;
}
