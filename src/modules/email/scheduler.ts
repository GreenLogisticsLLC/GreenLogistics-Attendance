import { emailImportService } from "./services/email-import.service.js";
import { gmailListener } from "./gmail/gmail.listener.js";
import { gmailOAuthService } from "./gmail/gmail-oauth.service.js";
import { brokerGmailSyncService } from "./gmail/broker-gmail-sync.service.js";
import { brokerGmailOAuthService } from "./gmail/broker-gmail-oauth.service.js";
import { isAdminWriteActive } from "../../config/database.js";

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startEmailImportScheduler(intervalMs = 15_000) {
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
            // Company + broker syncs must be independent — one failure must not block the other.
            if (await gmailListener.ensureCredentials().catch(() => false)) {
                try {
                    const result = await emailImportService.checkInbox({ maxMessages: 20 });
                    if (result.processed > 0) {
                        console.log(
                            `[email] processed=${result.processed} imported=${result.imported} ignored=${result.ignored} duplicates=${result.duplicates} errors=${result.errors}`
                        );
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (/invalid_grant|expired or revoked/i.test(msg)) {
                        gmailOAuthService.invalidateCompanyClient();
                        try {
                            const result = await emailImportService.checkInbox({ maxMessages: 20 });
                            if (result.processed > 0) {
                                console.log(
                                    `[email] processed=${result.processed} imported=${result.imported} ignored=${result.ignored} duplicates=${result.duplicates} errors=${result.errors}`
                                );
                            }
                        } catch (retryErr) {
                            console.error(
                                "[email] company inbox retry failed",
                                retryErr instanceof Error ? retryErr.message : retryErr
                            );
                        }
                    } else {
                        console.error("[email] company inbox tick failed", msg);
                    }
                }
            }

            if (brokerGmailOAuthService.isClientConfigured()) {
                try {
                    const broker = await brokerGmailSyncService.syncAllBrokers(12);
                    const failures = broker.results.filter(
                        (r) => r && typeof r === "object" && "ok" in r && (r as { ok?: boolean }).ok === false
                    );
                    for (const fail of failures) {
                        const row = fail as { gmailAddress?: string; error?: string };
                        console.warn(
                            `[broker-gmail] ${row.gmailAddress || "unknown"}: ${String(row.error || "sync failed").slice(0, 200)}`
                        );
                    }
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
                } catch (err) {
                    console.error(
                        "[broker-gmail] syncAll failed",
                        err instanceof Error ? err.message : err
                    );
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
