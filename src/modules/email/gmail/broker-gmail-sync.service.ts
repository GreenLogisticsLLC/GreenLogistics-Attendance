import { google } from "googleapis";
import { config } from "../../../config/env.js";
import { prisma } from "../../../config/database.js";
import { getGmailRedirectUri } from "./gmail-oauth.service.js";
import { brokerGmailOAuthService } from "./broker-gmail-oauth.service.js";
import type { RawEmailMessage } from "../models/types.js";
import { applyUshipLifecycleEvent } from "../parsers/uship/uship-lifecycle.detector.js";

const USHIP_QUERY =
    "from:(uship.com OR email.uship.com OR notifications.uship.com) newer_than:21d";

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

function isUshipRelated(fromAddress: string, subject: string, body: string): boolean {
    const from = (fromAddress || "").toLowerCase();
    const hay = `${subject}\n${body}`.toLowerCase();
    if (from.includes("uship.com") || from.includes("email.uship.com")) return true;
    if (hay.includes("uship.com") && (hay.includes("shipment") || hay.includes("listing") || hay.includes("bid"))) {
        return true;
    }
    return false;
}

/** Extract uShip listing id or view URL from email body/subject. */
function extractUshipRefs(text: string): { externalId?: string; viewUrl?: string } {
    const view =
        text.match(/https?:\/\/(?:www\.)?uship\.com\/listing\/[^\s"'<>]+/i)?.[0] ||
        text.match(/https?:\/\/(?:www\.)?uship\.com\/[^\s"'<>]*listing[^\s"'<>]*/i)?.[0];
    const external =
        text.match(/\/listing\/(\d+)/i)?.[1] ||
        text.match(/shipment\s*(?:id|#|number)?\s*[:#]?\s*(\d{5,})/i)?.[1];
    return {
        viewUrl: view ? view.replace(/[>,)\]]+$/, "") : undefined,
        externalId: external,
    };
}

async function matchShipment(input: {
    userId: string;
    externalId?: string;
    viewUrl?: string;
    subject: string;
    body: string;
}): Promise<{ shipmentLeadId: string; method: string } | null> {
    if (input.viewUrl) {
        const byUrl = await prisma.shipmentLead.findUnique({ where: { viewUrl: input.viewUrl } });
        if (byUrl) return { shipmentLeadId: byUrl.shipmentLeadId, method: "viewUrl" };
    }
    if (input.externalId) {
        const byExt = await prisma.shipmentLead.findFirst({
            where: { source: "USHIP", externalShipmentId: input.externalId },
        });
        if (byExt) return { shipmentLeadId: byExt.shipmentLeadId, method: "externalShipmentId" };
    }

    const gosMatch = `${input.subject} ${input.body}`.match(/GOS-\d{8}-\d+/i);
    if (gosMatch) {
        const byGos = await prisma.shipmentLead.findUnique({
            where: { greenOsShipmentId: gosMatch[0].toUpperCase() },
        });
        if (byGos) return { shipmentLeadId: byGos.shipmentLeadId, method: "greenOsShipmentId" };
    }

    // Prefer open shipments assigned to this broker (weak match by title tokens — skip for safety)
    return null;
}

export class BrokerGmailSyncService {
    private clientFor(refreshToken: string) {
        const oauth2 = new google.auth.OAuth2(
            config.gmail.clientId,
            config.gmail.clientSecret,
            getGmailRedirectUri()
        );
        oauth2.setCredentials({ refresh_token: refreshToken });
        return google.gmail({ version: "v1", auth: oauth2 });
    }

    private async fetchRaw(gmail: ReturnType<typeof google.gmail>, gmailMessageId: string): Promise<RawEmailMessage> {
        const res = await gmail.users.messages.get({
            userId: "me",
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

    async syncOneAccount(account: {
        brokerGmailId: string;
        userId: string;
        gmailAddress: string;
        refreshToken: string;
    }, maxMessages = 20) {
        const gmail = this.clientFor(account.refreshToken);
        let synced = 0;
        let ignored = 0;
        let matched = 0;
        let errors = 0;

        try {
            const list = await gmail.users.messages.list({
                userId: "me",
                q: `${USHIP_QUERY} is:unread`,
                maxResults: maxMessages,
            });
            const ids = (list.data.messages || []).map((m) => m.id!).filter(Boolean);

            for (const gmailMessageId of ids) {
                try {
                    const existing = await prisma.brokerMailboxMessage.findUnique({
                        where: {
                            userId_gmailMessageId: {
                                userId: account.userId,
                                gmailMessageId,
                            },
                        },
                    });
                    if (existing) {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: gmailMessageId,
                            requestBody: { removeLabelIds: ["UNREAD"] },
                        });
                        ignored += 1;
                        continue;
                    }

                    const raw = await this.fetchRaw(gmail, gmailMessageId);
                    const body = `${raw.bodyText || ""}\n${raw.bodyHtml || ""}`;

                    if (!isUshipRelated(raw.fromAddress, raw.subject, body)) {
                        // Personal / unrelated — do not store; mark read so we don't loop
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: gmailMessageId,
                            requestBody: { removeLabelIds: ["UNREAD"] },
                        });
                        ignored += 1;
                        continue;
                    }

                    const refs = extractUshipRefs(`${raw.subject}\n${body}\n${raw.snippet || ""}`);
                    const match = await matchShipment({
                        userId: account.userId,
                        externalId: refs.externalId,
                        viewUrl: refs.viewUrl,
                        subject: raw.subject,
                        body,
                    });

                    await prisma.brokerMailboxMessage.create({
                        data: {
                            userId: account.userId,
                            brokerGmailId: account.brokerGmailId,
                            gmailMessageId,
                            gmailThreadId: raw.gmailThreadId,
                            shipmentLeadId: match?.shipmentLeadId,
                            fromAddress: raw.fromAddress,
                            subject: raw.subject,
                            snippet: raw.snippet,
                            bodyText: (raw.bodyText || "").slice(0, 20000) || null,
                            receivedAt: raw.receivedAt,
                            matchMethod: match?.method || null,
                        },
                    });

                    if (match?.shipmentLeadId) {
                        matched += 1;
                        await applyUshipLifecycleEvent({
                            shipmentLeadId: match.shipmentLeadId,
                            subject: raw.subject,
                            body,
                            actorUserId: account.userId,
                            gmailMessageId,
                            source: "broker_gmail",
                        }).catch((err) => {
                            console.warn(
                                "[BROKER GMAIL] lifecycle apply failed:",
                                err instanceof Error ? err.message : err
                            );
                        });
                    }

                    await gmail.users.messages.modify({
                        userId: "me",
                        id: gmailMessageId,
                        requestBody: { removeLabelIds: ["UNREAD"] },
                    });
                    synced += 1;
                } catch (err) {
                    errors += 1;
                    console.warn(
                        `[BROKER GMAIL] message ${gmailMessageId} failed:`,
                        err instanceof Error ? err.message : err
                    );
                }
            }

            await prisma.brokerGmailAccount.update({
                where: { brokerGmailId: account.brokerGmailId },
                data: { lastSyncAt: new Date(), lastError: null },
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await prisma.brokerGmailAccount.update({
                where: { brokerGmailId: account.brokerGmailId },
                data: { lastError: message.slice(0, 500) },
            });
            throw err;
        }

        return { synced, ignored, matched, errors, gmailAddress: account.gmailAddress };
    }

    async syncAllBrokers(maxPerAccount = 15) {
        if (!brokerGmailOAuthService.isClientConfigured()) {
            return { configured: false, accounts: 0, results: [] as unknown[] };
        }
        const accounts = await brokerGmailOAuthService.listActiveAccounts();
        const results = [];
        for (const acc of accounts) {
            try {
                const r = await this.syncOneAccount(
                    {
                        brokerGmailId: acc.brokerGmailId,
                        userId: acc.userId,
                        gmailAddress: acc.gmailAddress,
                        refreshToken: acc.refreshToken,
                    },
                    maxPerAccount
                );
                results.push({ userId: acc.userId, ok: true, ...r });
            } catch (err) {
                results.push({
                    userId: acc.userId,
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                    gmailAddress: acc.gmailAddress,
                });
            }
        }
        return { configured: true, accounts: accounts.length, results };
    }

    listMessagesForBroker(userId: string, limit = 50) {
        return prisma.brokerMailboxMessage.findMany({
            where: { userId },
            orderBy: { receivedAt: "desc" },
            take: limit,
        });
    }

    listMessagesForShipment(shipmentLeadId: string) {
        return prisma.brokerMailboxMessage.findMany({
            where: { shipmentLeadId },
            orderBy: { receivedAt: "asc" },
        });
    }
}

export const brokerGmailSyncService = new BrokerGmailSyncService();
