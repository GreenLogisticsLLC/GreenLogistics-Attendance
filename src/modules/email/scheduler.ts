import { emailImportService } from "./services/email-import.service.js";
import { gmailListener } from "./gmail/gmail.listener.js";
import { isAdminWriteActive } from "../../config/database.js";

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startEmailImportScheduler(intervalMs = 30_000) {
    if (timer) return;
    console.log(`[email] scheduler started (every ${intervalMs / 1000}s)`);

    const tick = async () => {
        if (running) return;
        if (isAdminWriteActive()) {
            console.log("[email] skip tick — admin write in progress");
            return;
        }
        if (!(await gmailListener.ensureCredentials())) return;
        running = true;
        try {
            const result = await emailImportService.checkInbox({ maxMessages: 20 });
            if (result.processed > 0) {
                console.log(
                    `[email] processed=${result.processed} imported=${result.imported} ignored=${result.ignored} duplicates=${result.duplicates} errors=${result.errors}`
                );
            }
        } catch (err) {
            console.error("[email] scheduler tick failed", err);
        } finally {
            running = false;
        }
    };

    // First tick shortly after boot, then every interval.
    setTimeout(tick, 5_000);
    timer = setInterval(tick, intervalMs);
}

export function stopEmailImportScheduler() {
    if (timer) clearInterval(timer);
    timer = null;
}

/** True while a checkInbox tick is mid-flight (caller can wait briefly). */
export function isEmailImportRunning(): boolean {
    return running;
}

export async function waitForEmailImportIdle(maxWaitMs = 45_000): Promise<void> {
    const start = Date.now();
    while (running && Date.now() - start < maxWaitMs) {
        await new Promise((r) => setTimeout(r, 200));
    }
}
