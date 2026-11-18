import {
    processOverdueBrokerReplies,
} from "./services/broker-response-problem.service.js";
import { processOverdueLoadLates } from "./services/load-late-problem.service.js";
import { bigProblemsService } from "../big-problems/services/big-problems.service.js";
import { isAdminWriteActive } from "../../config/database.js";

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startBrokerResponseTimeoutScheduler(intervalMs = 30_000) {
    if (timer) return;
    console.log(
        `[problems] timeout scheduler started (every ${intervalMs / 1000}s — broker reply 10m + load late 15m + BP overdue tasks)`
    );

    const tick = async () => {
        if (running || isAdminWriteActive()) return;
        running = true;
        try {
            const replies = await processOverdueBrokerReplies(40);
            if (replies > 0) {
                console.log(`[problems] archived ${replies} Customer Respond timeout(s)`);
            }
            const lates = await processOverdueLoadLates(80);
            if (lates > 0) {
                console.log(`[problems/late] archived ${lates} load late event(s)`);
            }
            const overdueBp = await bigProblemsService.processOverdueTaskReminders(80);
            if (overdueBp > 0) {
                console.log(`[problems/big] notified ${overdueBp} overdue Big Problem task(s)`);
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
