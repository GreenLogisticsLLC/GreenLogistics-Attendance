import { emailImportService } from "./services/email-import.service.js";
import { gmailListener } from "./gmail/gmail.listener.js";
import { brokerGmailSyncService } from "./gmail/broker-gmail-sync.service.js";
import { brokerGmailOAuthService } from "./gmail/broker-gmail-oauth.service.js";
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
        running = true;
        try {
            if (await gmailListener.ensureCredentials()) {
                const result = await emailImportService.checkInbox({ maxMessages: 20 });
                if (result.processed > 0) {
                    console.log(
                        `[email] processed=${result.processed} imported=${result.imported} ignored=${result.ignored} duplicates=${result.duplicates} errors=${result.errors}`
                    );
                }
            }

            if (brokerGmailOAuthService.isClientConfigured()) {
                const broker = await brokerGmailSyncService.syncAllBrokers(12);
                const touched = broker.results.filter(
                    (r) =>
                        r &&
                        typeof r === "object" &&
                        "synced" in r &&
                        Number((r as { synced?: number }).synced || 0) > 0
                );
                if (touched.length) {
                    console.log(`[broker-gmail] synced ${touched.length} mailbox update(s)`);
                }
            }
        } catch (err) {
            console.error("[email] scheduler tick failed", err);
        } finally {
            running = false;
        }
    };

    setTimeout(tick, 5_000);
    timer = setInterval(tick, intervalMs);
}

export function stopEmailImportScheduler() {
    if (timer) clearInterval(timer);
    timer = null;
}

export function isEmailImportRunning(): boolean {
    return running;
}

export async function waitForEmailImportIdle(maxWaitMs = 5_000): Promise<void> {
    const start = Date.now();
    while (running && Date.now() - start < maxWaitMs) {
        await new Promise((r) => setTimeout(r, 100));
    }
}
