import { google } from "googleapis";
import { config } from "../../../config/env.js";
import { gmailOAuthService } from "./gmail-oauth.service.js";
import type { RawEmailMessage } from "../models/types.js";

function decodeBase64Url(data?: string | null): string {
    if (!data) return "";
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf8");
}

function collectParts(
    part: {
        mimeType?: string | null;
        body?: { data?: string | null } | null;
        parts?: unknown[] | null;
    } | null | undefined,
    out: { text: string; html: string }
) {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data) {
        out.text += decodeBase64Url(part.body.data);
    }
    if (part.mimeType === "text/html" && part.body?.data) {
        out.html += decodeBase64Url(part.body.data);
    }
    if (Array.isArray(part.parts)) {
        for (const child of part.parts) {
            collectParts(child as typeof part, out);
        }
    }
}

function headerValue(
    headers: Array<{ name?: string | null; value?: string | null }> | undefined,
    name: string
): string {
    return headers?.find((h) => (h.name || "").toLowerCase() === name.toLowerCase())?.value || "";
}

export class GmailListener {
    /** Sync check using in-memory / env values (may be stale until ensureCredentials). */
    isConfigured(): boolean {
        return Boolean(
            config.gmail.clientId &&
                config.gmail.clientSecret &&
                config.gmail.refreshToken &&
                config.gmail.user
        );
    }

    async ensureCredentials(): Promise<boolean> {
        if (!gmailOAuthService.isClientConfigured()) return false;
        const [{ token: refreshToken }, user] = await Promise.all([
            gmailOAuthService.getStoredRefreshToken(),
            gmailOAuthService.getStoredUser(),
        ]);
        if (refreshToken) gmailOAuthService.applyRuntimeCredentials(refreshToken, user || undefined);
        return this.isConfigured();
    }

    private async getClient() {
        if (!gmailOAuthService.isClientConfigured()) {
            throw new Error("Gmail is not configured");
        }
        const { token: refreshToken, source } = await gmailOAuthService.getStoredRefreshToken();
        const user = await gmailOAuthService.getStoredUser();
        if (!refreshToken || !user) {
            throw new Error("Gmail is not configured");
        }
        gmailOAuthService.applyRuntimeCredentials(refreshToken, user);
        // Shared client: one access-token refresh for the whole inbox tick.
        const oauth2 = gmailOAuthService.getSharedAuthedClient(refreshToken);
        if (source === "env") {
            console.warn(
                "[GMAIL] Using refresh token from .env fallback — reconnect via /api/email/auth to persist in settings"
            );
        }
        return google.gmail({ version: "v1", auth: oauth2 });
    }

    async listUnreadMessageIds(maxResults = 25, options?: { after?: Date | null }): Promise<string[]> {
        if (!(await this.ensureCredentials())) return [];
        const gmail = await this.getClient();
        let q = "is:unread from:uship.com";
        if (options?.after && !Number.isNaN(options.after.getTime())) {
            // Gmail `after:` is date-only (UTC day). Fine-grained filter uses receivedAt later.
            const y = options.after.getUTCFullYear();
            const m = String(options.after.getUTCMonth() + 1).padStart(2, "0");
            const d = String(options.after.getUTCDate()).padStart(2, "0");
            q = `is:unread from:uship.com after:${y}/${m}/${d}`;
        }
        const res = await gmail.users.messages.list({
            userId: config.gmail.user,
            q,
            maxResults,
        });
        return (res.data.messages || []).map((m) => m.id!).filter(Boolean);
    }

    async fetchMessage(gmailMessageId: string): Promise<RawEmailMessage> {
        const gmail = await this.getClient();
        const res = await gmail.users.messages.get({
            userId: config.gmail.user,
            id: gmailMessageId,
            format: "full",
        });

        const payload = res.data.payload;
        const headers = payload?.headers || [];
        const bodies = { text: "", html: "" };
        collectParts(payload, bodies);
        if (!bodies.text && !bodies.html && payload?.body?.data) {
            bodies.text = decodeBase64Url(payload.body.data);
        }

        const internalDate = res.data.internalDate
            ? new Date(Number(res.data.internalDate))
            : new Date();

        return {
            gmailMessageId,
            gmailThreadId: res.data.threadId || undefined,
            fromAddress: headerValue(headers, "From"),
            subject: headerValue(headers, "Subject") || "(no subject)",
            snippet: res.data.snippet || undefined,
            receivedAt: internalDate,
            bodyText: bodies.text || undefined,
            bodyHtml: bodies.html || undefined,
            rawHeaders: JSON.stringify(headers),
        };
    }

    async markProcessed(gmailMessageId: string): Promise<void> {
        if (!(await this.ensureCredentials())) return;
        const gmail = await this.getClient();
        const labelIds = ["UNREAD"];
        if (config.gmail.processedLabelId) {
            await gmail.users.messages.modify({
                userId: config.gmail.user,
                id: gmailMessageId,
                requestBody: {
                    removeLabelIds: labelIds,
                    addLabelIds: [config.gmail.processedLabelId],
                },
            });
            return;
        }
        await gmail.users.messages.modify({
            userId: config.gmail.user,
            id: gmailMessageId,
            requestBody: { removeLabelIds: labelIds },
        });
    }
}

export const gmailListener = new GmailListener();
