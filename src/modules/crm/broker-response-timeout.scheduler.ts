import {
    processOverdueBrokerReplies,
} from "./services/broker-response-problem.service.js";
import { isAdminWriteActive } from "../../config/database.js";

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startBrokerResponseTimeoutScheduler(intervalMs = 30_000) {
    if (timer) return;
    console.log(
        `[problems] broker-reply timeout scheduler started (every ${intervalMs / 1000}s, 10m SLA)`
    );

    const tick = async () => {
        if (running || isAdminWriteActive()) return;
        running = true;
        try {
            const n = await processOverdueBrokerReplies(40);
            if (n > 0) {
                console.log(`[problems] archived ${n} Customer Respond timeout(s)`);
            }
        } catch (err) {
            console.error(
                "[problems] timeout tick failed",
                err instanceof Error ? err.message : err
            );
        } finally {
            running = false;
        }
    };

    setTimeout(tick, 12_000);
    timer = setInterval(tick, intervalMs);
}

export function stopBrokerResponseTimeoutScheduler() {
    if (timer) clearInterval(timer);
    timer = null;
}
