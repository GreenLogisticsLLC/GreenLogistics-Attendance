import { assignmentEngine } from "./assignment.engine.js";
import { isAdminWriteActive } from "../../config/database.js";

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Acceptance deadlines must advance even when company Gmail is idle —
 * otherwise AWAITING_ACCEPTANCE / AGENT_OPEN never pass if Accept was not clicked.
 */
export function startAssignmentAcceptanceScheduler(intervalMs = 60_000) {
    if (timer) return;
    console.log(`[assignment] acceptance scheduler started (every ${intervalMs / 1000}s)`);

    const tick = async () => {
        if (running || isAdminWriteActive()) return;
        running = true;
        try {
            await assignmentEngine.processDueAcceptances();
            await assignmentEngine.assignPendingNewLeads(5);
        } catch (err) {
            console.error(
                "[assignment] acceptance tick failed",
                err instanceof Error ? err.message : err
            );
        } finally {
            running = false;
        }
    };

    setTimeout(tick, 8_000);
    timer = setInterval(tick, intervalMs);
}

export function stopAssignmentAcceptanceScheduler() {
    if (timer) clearInterval(timer);
    timer = null;
}
