import { emailImportService } from "./services/email-import.service.js";
import { gmailListener } from "./gmail/gmail.listener.js";

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startEmailImportScheduler(intervalMs = 30_000) {
    if (timer) return;
    console.log(`[email] scheduler started (every ${intervalMs / 1000}s)`);

    const tick = async () => {
        if (running) return;
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
