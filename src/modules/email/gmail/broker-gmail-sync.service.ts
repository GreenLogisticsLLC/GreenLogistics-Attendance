import { google } from "googleapis";
import { config } from "../../../config/env.js";
import { prisma } from "../../../config/database.js";
import { getGmailRedirectUri } from "./gmail-oauth.service.js";
import {
    brokerGmailOAuthService,
    decryptBrokerRefreshToken,
} from "./broker-gmail-oauth.service.js";
import type { RawEmailMessage } from "../models/types.js";
import { applyUshipLifecycleEvent } from "../parsers/uship/uship-lifecycle.detector.js";

const USHIP_QUERY =
    "from:(uship.com OR email.uship.com OR notifications.uship.com OR mail.uship.com) newer_than:21d";

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

function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ")
        .trim();
}

function isUshipRelated(fromAddress: string, subject: string, body: string): boolean {
    const from = (fromAddress || "").toLowerCase();
    const hay = `${subject}\n${body}`.toLowerCase();
    if (
        from.includes("uship.com") ||
        from.includes("email.uship.com") ||
        from.includes("notifications.uship.com") ||
        from.includes("mail.uship.com")
    ) {
        return true;
    }
    if (
        hay.includes("uship.com") &&
        (hay.includes("shipment") ||
            hay.includes("listing") ||
            hay.includes("bid") ||
            hay.includes("quote"))
    ) {
        return true;
    }
    return false;
}

function normalizeListingUrl(url: string): string {
    const cleaned = url.replace(/[>,)\]]+$/, "").trim();
    try {
        const u = new URL(cleaned);
        const m = u.pathname.match(/\/listing\/(\d+)/i);
        if (m?.[1]) return `https://www.uship.com/listing/${m[1]}`;
        return `${u.origin}${u.pathname}`.replace(/\/$/, "");
    } catch {
        return cleaned.split("?")[0].split("#")[0].replace(/\/$/, "");
    }
}

/** Extract uShip listing id or view URL from email body/subject. */
function extractUshipRefs(text: string): { externalId?: string; viewUrl?: string } {
    const rawView =
        text.match(/https?:\/\/(?:www\.)?uship\.com\/listing\/[^\s"'<>]+/i)?.[0] ||
        text.match(/https?:\/\/(?:www\.)?uship\.com\/[^\s"'<>]*listing[^\s"'<>]*/i)?.[0];
    const external =
        text.match(/\/listing\/(\d{5,})/i)?.[1] ||
        text.match(/listing\s*(?:id|#|number)?\s*[:#]?\s*(\d{5,})/i)?.[1] ||
        text.match(/shipment\s*(?:id|#|number)?\s*[:#]?\s*(\d{5,})/i)?.[1];
    const viewUrl = rawView ? normalizeListingUrl(rawView) : undefined;
    return {
        viewUrl,
        externalId: external || (viewUrl ? viewUrl.match(/\/listing\/(\d+)/i)?.[1] : undefined),
    };
}

async function matchShipment(input: {
    userId: string;
    brokerGmailId: string;
    gmailThreadId?: string;
    externalId?: string;
    viewUrl?: string;
    subject: string;
    body: string;
}): Promise<{ shipmentLeadId: string; method: string } | null> {
    let candidate: { shipmentLeadId: string; assignedBrokerId: string | null } | null = null;
    let method = "";

    if (input.viewUrl) {
        const normalized = normalizeListingUrl(input.viewUrl);
        candidate = await prisma.shipmentLead.findFirst({
            where: {
                OR: [
                    { viewUrl: normalized },
                    { viewUrl: input.viewUrl },
                    { viewUrl: { contains: `/listing/${normalized.match(/\/listing\/(\d+)/i)?.[1] || "__none__"}` } },
                ],
            },
            select: { shipmentLeadId: true, assignedBrokerId: true },
        });
        method = "viewUrl";
    }

    if (!candidate && input.externalId) {
        candidate = await prisma.shipmentLead.findFirst({
            where: {
                OR: [
                    { source: "USHIP", externalShipmentId: input.externalId },
                    { viewUrl: { contains: `/listing/${input.externalId}` } },
                    { externalShipmentId: input.externalId },
                ],
            },
            select: { shipmentLeadId: true, assignedBrokerId: true },
        });
        method = "externalShipmentId";
    }

    const gosSeq = `${input.subject} ${input.body}`.match(/\bGOS(\d{7,})\b/i);
    if (!candidate && gosSeq) {
        candidate = await prisma.shipmentLead.findUnique({
            where: { greenOsShipmentId: `GOS${gosSeq[1]}` },
            select: { shipmentLeadId: true, assignedBrokerId: true },
        });
        method = "greenOsShipmentId";
    }

    const gosLegacy = `${input.subject} ${input.body}`.match(/GOS-\d{8}-\d+/i);
    if (!candidate && gosLegacy) {
        candidate = await prisma.shipmentLead.findUnique({
            where: { greenOsShipmentId: gosLegacy[0].toUpperCase() },
            select: { shipmentLeadId: true, assignedBrokerId: true },
        });
        method = "greenOsShipmentId";
    }

    if (!candidate && input.gmailThreadId) {
        const prior = await prisma.brokerMailboxMessage.findFirst({
            where: {
                brokerGmailId: input.brokerGmailId,
                gmailThreadId: input.gmailThreadId,
                shipmentLeadId: { not: null },
            },
            orderBy: { receivedAt: "desc" },
            select: {
                shipmentLead: {
                    select: { shipmentLeadId: true, assignedBrokerId: true },
                },
            },
        });
        candidate = prior?.shipmentLead || null;
        method = "gmailThreadId";
    }

    // Soft fallback: unique vehicle / title match among this broker's active loads.
    if (!candidate) {
        const hay = `${input.subject}\n${input.body}`.toLowerCase();
        const active = await prisma.shipmentLead.findMany({
            where: {
                assignedBrokerId: input.userId,
                status: {
                    in: [
                        "AWAITING_ACCEPTANCE",
                        "AGENT_OPEN",
                        "WORKING",
                        "FOLLOW_UP",
                        "BID_SUBMITTED",
                        "CUSTOMER_REPLIED",
                    ],
                },
            },
            select: {
                shipmentLeadId: true,
                assignedBrokerId: true,
                shipmentTitle: true,
                vehicle: true,
                pickupCity: true,
                deliveryCity: true,
            },
            take: 40,
        });
        const hits = active.filter((row) => {
            const tokens = [row.vehicle, row.shipmentTitle, row.pickupCity, row.deliveryCity]
                .map((v) => String(v || "").trim().toLowerCase())
                .filter((v) => v.length >= 4);
            return tokens.some((t) => hay.includes(t));
        });
        if (hits.length === 1) {
            candidate = hits[0];
            method = "activeShipmentHeuristic";
        }
    }

    // Hard routing boundary: a broker mailbox can update only that broker's assigned Shipment.
    if (!candidate || candidate.assignedBrokerId !== input.userId) return null;
    return { shipmentLeadId: candidate.shipmentLeadId, method };
}

export class BrokerGmailSyncService {
    private clientFor(encryptedRefreshToken: string) {
        const oauth2 = new google.auth.OAuth2(
            config.gmail.clientId,
            config.gmail.clientSecret,
            getGmailRedirectUri()
        );
        oauth2.setCredentials({ refresh_token: decryptBrokerRefreshToken(encryptedRefreshToken) });
        return google.gmail({ version: "v1", auth: oauth2 });
    }

    private async listNewMessageIds(
        gmail: ReturnType<typeof google.gmail>,
        account: { historyId: string | null; lastSyncAt: Date | null },
        maxMessages: number
    ): Promise<string[]> {
        const ids = new Set<string>();
        if (account.historyId) {
            try {
                let pageToken: string | undefined;
                do {
                    const page = await gmail.users.history.list({
                        userId: "me",
                        startHistoryId: account.historyId,
                        historyTypes: ["messageAdded"],
                        pageToken,
                        maxResults: Math.min(100, maxMessages),
                    });
                    for (const entry of page.data.history || []) {
                        for (const added of entry.messagesAdded || []) {
                            if (added.message?.id) ids.add(added.message.id);
                            if (ids.size >= maxMessages) break;
                        }
                    }
                    pageToken = page.data.nextPageToken || undefined;
                } while (pageToken && ids.size < maxMessages);
            } catch (err) {
                const code = (err as { code?: number }).code;
                if (code !== 404) throw err;
                console.warn("[BROKER GMAIL] history cursor expired; using time-based recovery");
            }
        }

        // Always merge a recent uShip query so Quote Confirmation emails are not missed
        // when History API skips or when the first sync after connect is delayed.
        const list = await gmail.users.messages.list({
            userId: "me",
            q: USHIP_QUERY,
            maxResults: Math.max(maxMessages, 25),
        });
        for (const message of list.data.messages || []) {
            if (message.id) ids.add(message.id);
        }

        if (!ids.size && account.lastSyncAt) {
            const after = Math.floor((account.lastSyncAt.getTime() - 5 * 60_000) / 1000);
            const fallback = await gmail.users.messages.list({
                userId: "me",
                q: `${USHIP_QUERY} after:${after}`,
                maxResults: maxMessages,
            });
            for (const message of fallback.data.messages || []) {
                if (message.id) ids.add(message.id);
            }
        }

        return [...ids].slice(0, Math.max(maxMessages * 2, 40));
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

    private async applyMatchedLifecycle(input: {
        shipmentLeadId: string;
        subject: string;
        body: string;
        actorUserId: string;
        gmailMessageId: string;
    }) {
        await applyUshipLifecycleEvent({
            shipmentLeadId: input.shipmentLeadId,
            subject: input.subject,
            body: input.body,
            actorUserId: input.actorUserId,
            gmailMessageId: input.gmailMessageId,
            source: "broker_gmail",
        }).catch((err) => {
            console.warn(
                "[BROKER GMAIL] lifecycle apply failed:",
                err instanceof Error ? err.message : err
            );
        });
    }

    /** Re-try unmatched / misclassified uShip emails (e.g. Quote Confirmation). */
    private async rematchUnmatched(account: {
        brokerGmailId: string;
        userId: string;
    }) {
        const rows = await prisma.brokerMailboxMessage.findMany({
            where: {
                brokerGmailId: account.brokerGmailId,
                receivedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
            },
            orderBy: { receivedAt: "desc" },
            take: 40,
        });
        let rematched = 0;
        for (const row of rows) {
            const body = `${row.bodyText || ""}\n${row.snippet || ""}`;
            let shipmentLeadId = row.shipmentLeadId;
            let method = row.matchMethod;

            if (!shipmentLeadId) {
                const refs = extractUshipRefs(`${row.subject}\n${body}`);
                const match = await matchShipment({
                    userId: account.userId,
                    brokerGmailId: account.brokerGmailId,
                    gmailThreadId: row.gmailThreadId || undefined,
                    externalId: refs.externalId,
                    viewUrl: refs.viewUrl,
                    subject: row.subject,
                    body,
                });
                if (!match) continue;
                shipmentLeadId = match.shipmentLeadId;
                method = match.method;
                await prisma.brokerMailboxMessage.update({
                    where: { messageId: row.messageId },
                    data: {
                        shipmentLeadId,
                        matchMethod: method,
                    },
                });
            }

            const looksQuoteOrBid =
                /quote|bid\s+confirmation|bid\s+submitted|submitted\s+a\s+(?:quote|bid)/i.test(
                    `${row.subject}\n${body}`
                );
            // Re-apply for newly matched rows, or quote/bid confirmations that may have been UNKNOWN before.
            if (!row.shipmentLeadId || looksQuoteOrBid) {
                await this.applyMatchedLifecycle({
                    shipmentLeadId,
                    subject: row.subject,
                    body,
                    actorUserId: account.userId,
                    gmailMessageId: row.gmailMessageId,
                });
                rematched += 1;
            }
        }
        return rematched;
    }

    async syncOneAccount(account: {
        brokerGmailId: string;
        userId: string;
        gmailAddress: string;
        refreshToken: string;
        historyId: string | null;
        lastSyncAt: Date | null;
    }, maxMessages = 20) {
        const gmail = this.clientFor(account.refreshToken);
        let synced = 0;
        let ignored = 0;
        let matched = 0;
        let errors = 0;

        try {
            const ids = await this.listNewMessageIds(gmail, account, maxMessages);

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
                        // Previously stored unmatched — try again with improved matcher/detector.
                        if (!existing.shipmentLeadId) {
                            const body = `${existing.bodyText || ""}\n${existing.snippet || ""}`;
                            const refs = extractUshipRefs(`${existing.subject}\n${body}`);
                            const match = await matchShipment({
                                userId: account.userId,
                                brokerGmailId: account.brokerGmailId,
                                gmailThreadId: existing.gmailThreadId || undefined,
                                externalId: refs.externalId,
                                viewUrl: refs.viewUrl,
                                subject: existing.subject,
                                body,
                            });
                            if (match) {
                                await prisma.brokerMailboxMessage.update({
                                    where: { messageId: existing.messageId },
                                    data: {
                                        shipmentLeadId: match.shipmentLeadId,
                                        matchMethod: match.method,
                                    },
                                });
                                await this.applyMatchedLifecycle({
                                    shipmentLeadId: match.shipmentLeadId,
                                    subject: existing.subject,
                                    body,
                                    actorUserId: account.userId,
                                    gmailMessageId,
                                });
                                matched += 1;
                            }
                        }
                        ignored += 1;
                        continue;
                    }

                    const raw = await this.fetchRaw(gmail, gmailMessageId);
                    const bodyText = raw.bodyText || "";
                    const bodyHtml = raw.bodyHtml ? stripHtml(raw.bodyHtml) : "";
                    const body = `${bodyText}\n${bodyHtml}\n${raw.snippet || ""}`;

                    if (!isUshipRelated(raw.fromAddress, raw.subject, body)) {
                        ignored += 1;
                        continue;
                    }

                    const refs = extractUshipRefs(`${raw.subject}\n${body}`);
                    const match = await matchShipment({
                        userId: account.userId,
                        brokerGmailId: account.brokerGmailId,
                        gmailThreadId: raw.gmailThreadId,
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
                            bodyText: body.slice(0, 20000) || null,
                            receivedAt: raw.receivedAt,
                            matchMethod: match?.method || null,
                        },
                    });

                    if (match?.shipmentLeadId) {
                        matched += 1;
                        await this.applyMatchedLifecycle({
                            shipmentLeadId: match.shipmentLeadId,
                            subject: raw.subject,
                            body,
                            actorUserId: account.userId,
                            gmailMessageId,
                        });
                    } else {
                        console.warn(
                            `[BROKER GMAIL] unmatched uShip mail for ${account.gmailAddress}: "${raw.subject.slice(0, 120)}"`
                        );
                    }

                    synced += 1;
                } catch (err) {
                    errors += 1;
                    console.warn(
                        `[BROKER GMAIL] message ${gmailMessageId} failed:`,
                        err instanceof Error ? err.message : err
                    );
                }
            }

            const rematched = await this.rematchUnmatched(account);
            if (rematched > 0) matched += rematched;

            const profile = await gmail.users.getProfile({ userId: "me" });
            await prisma.brokerGmailAccount.update({
                where: { brokerGmailId: account.brokerGmailId },
                data: {
                    historyId: profile.data.historyId || account.historyId,
                    lastSyncAt: new Date(),
                    status: "CONNECTED",
                    isActive: true,
                    lastError: null,
                },
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const reconnect = /invalid_grant|expired or revoked|unauthorized/i.test(message);
            console.warn(
                `[broker-gmail] sync failed for ${account.gmailAddress}: ${message.slice(0, 200)}` +
                    (reconnect ? " → RECONNECT_REQUIRED" : "")
            );
            await prisma.brokerGmailAccount.update({
                where: { brokerGmailId: account.brokerGmailId },
                data: {
                    lastError: message.slice(0, 500),
                    status: reconnect ? "RECONNECT_REQUIRED" : "CONNECTED",
                },
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
        const results: Array<Record<string, unknown>> = new Array(accounts.length);
        let nextIndex = 0;

        const workers = Array.from({ length: Math.min(4, Math.max(1, accounts.length)) }, async () => {
            while (true) {
                const i = nextIndex++;
                if (i >= accounts.length) break;
                const acc = accounts[i];
                try {
                    results[i] = {
                        ok: true,
                        ...(await this.syncOneAccount(
                            {
                                brokerGmailId: acc.brokerGmailId,
                                userId: acc.userId,
                                gmailAddress: acc.gmailAddress,
                                refreshToken: acc.refreshToken,
                                historyId: acc.historyId,
                                lastSyncAt: acc.lastSyncAt,
                            },
                            maxPerAccount
                        )),
                    };
                } catch (err) {
                    results[i] = {
                        ok: false,
                        gmailAddress: acc.gmailAddress,
                        error: err instanceof Error ? err.message : String(err),
                    };
                }
            }
        });
        await Promise.all(workers);
        return { configured: true, accounts: accounts.length, results };
    }

    listMessagesForBroker(userId: string, limit = 50) {
        return prisma.brokerMailboxMessage.findMany({
            where: { userId },
            orderBy: { receivedAt: "desc" },
            take: limit,
            include: {
                shipmentLead: {
                    select: {
                        shipmentLeadId: true,
                        greenOsShipmentId: true,
                        shipmentTitle: true,
                        status: true,
                    },
                },
            },
        });
    }
}

export const brokerGmailSyncService = new BrokerGmailSyncService();
