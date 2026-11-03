import { notifyCarrierMissingOnPickup } from "./carrier-missing-notify.js";
import { isAdminWriteActive } from "../../config/database.js";

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Look for pickup-day loads that still have no carrier. */
export function startCarrierMissingScheduler(intervalMs = 15 * 60 * 1000) {
    if (timer) return;
    console.log(`[loads] carrier-missing scheduler started (every ${intervalMs / 1000}s)`);
    const tick = async () => {
        if (running || isAdminWriteActive()) return;
        running = true;
        try {
            const created = await notifyCarrierMissingOnPickup();
            if (created > 0) {
                console.log(`[loads] carrier-missing alerts sent: ${created}`);
            }
        } catch (err) {
            console.error(
                "[loads] carrier-missing tick failed",
                err instanceof Error ? err.message : err
            );
        } finally {
            running = false;
        }
    };
    setTimeout(tick, 20_000);
    timer = setInterval(tick, intervalMs);
}
