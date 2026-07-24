import { google } from "googleapis";
import { config } from "../../../config/env.js";
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
    isConfigured(): boolean {
        return Boolean(
            config.gmail.clientId &&
                config.gmail.clientSecret &&
                config.gmail.refreshToken &&
                config.gmail.user
        );
    }

    private getClient() {
        const oauth2 = new google.auth.OAuth2(
            config.gmail.clientId,
            config.gmail.clientSecret
        );
        oauth2.setCredentials({ refresh_token: config.gmail.refreshToken });
        return google.gmail({ version: "v1", auth: oauth2 });
    }

    async listUnreadMessageIds(maxResults = 25): Promise<string[]> {
        if (!this.isConfigured()) return [];
        const gmail = this.getClient();
        const res = await gmail.users.messages.list({
            userId: config.gmail.user,
            q: "is:unread",
            maxResults,
        });
        return (res.data.messages || []).map((m) => m.id!).filter(Boolean);
    }

    async fetchMessage(gmailMessageId: string): Promise<RawEmailMessage> {
        const gmail = this.getClient();
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
        if (!this.isConfigured()) return;
        const gmail = this.getClient();
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
