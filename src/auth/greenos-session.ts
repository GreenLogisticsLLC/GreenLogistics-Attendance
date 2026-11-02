/** Brokers must use Green OS. No activity for this long ends the session. */
export const GREEN_OS_IDLE_MS = 20 * 60 * 1000;

export const GREEN_OS_IDLE_MESSAGE =
    "Signed out after 20 minutes without activity. Sign in again to receive new shipments.";

export function isGreenOsSessionFresh(
    lastActivityAt: Date | string | null | undefined,
    now = Date.now()
): boolean {
    if (!lastActivityAt) return false;
    const at = new Date(lastActivityAt).getTime();
    if (!Number.isFinite(at)) return false;
    return now - at < GREEN_OS_IDLE_MS;
}
