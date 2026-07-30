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
        candidate = await prisma.shipmentLead.findUnique({
            where: { viewUrl: input.viewUrl },
            select: { shipmentLeadId: true, assignedBrokerId: true },
        });
        method = "viewUrl";
    }
    if (!candidate && input.externalId) {
        candidate = await prisma.shipmentLead.findFirst({
            where: { source: "USHIP", externalShipmentId: input.externalId },
            select: { shipmentLeadId: true, assignedBrokerId: true },
        });
        method = "externalShipmentId";
    }

    const gosMatch = `${input.subject} ${input.body}`.match(/GOS-\d{8}-\d+/i);
    if (!candidate && gosMatch) {
        candidate = await prisma.shipmentLead.findUnique({
            where: { greenOsShipmentId: gosMatch[0].toUpperCase() },
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
                return [...ids];
            } catch (err) {
                const code = (err as { code?: number }).code;
                if (code !== 404) throw err;
                console.warn("[BROKER GMAIL] history cursor expired; using time-based recovery");
            }
        }

        const after = Math.floor(
            ((account.lastSyncAt?.getTime() || Date.now()) - 5 * 60_000) / 1000
        );
        const list = await gmail.users.messages.list({
            userId: "me",
            q: `${USHIP_QUERY} after:${after}`,
            maxResults: maxMessages,
        });
        return (list.data.messages || []).map((message) => message.id!).filter(Boolean);
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
                        ignored += 1;
                        continue;
                    }

                    const raw = await this.fetchRaw(gmail, gmailMessageId);
                    const body = `${raw.bodyText || ""}\n${raw.bodyHtml || ""}`;

                    if (!isUshipRelated(raw.fromAddress, raw.subject, body)) {
                        // Personal / unrelated — never store it.
                        ignored += 1;
                        continue;
                    }

                    const refs = extractUshipRefs(`${raw.subject}\n${body}\n${raw.snippet || ""}`);
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

                    synced += 1;
                } catch (err) {
                    errors += 1;
                    console.warn(
                        `[BROKER GMAIL] message ${gmailMessageId} failed:`,
                        err instanceof Error ? err.message : err
                    );
                }
            }

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
            await prisma.brokerGmailAccount.update({
                where: { brokerGmailId: account.brokerGmailId },
                data: {
                    lastError: message.slice(0, 500),
                    status: /invalid_grant|unauthorized/i.test(message)
                        ? "RECONNECT_REQUIRED"
                        : "CONNECTED",
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

        // Bounded parallelism keeps a large account list inside the 30-second
        // scheduler window without opening hundreds of Gmail/DB requests at once.
        const worker = async () => {
            while (true) {
                const index = nextIndex++;
                const acc = accounts[index];
                if (!acc) return;
                try {
                    const synced = await this.syncOneAccount(
                        {
                            brokerGmailId: acc.brokerGmailId,
                            userId: acc.userId,
                            gmailAddress: acc.gmailAddress,
                            refreshToken: acc.refreshToken,
                            historyId: acc.historyId,
                            lastSyncAt: acc.lastSyncAt,
                        },
                        maxPerAccount
                    );
                    results[index] = { userId: acc.userId, ok: true, ...synced };
                } catch (err) {
                    results[index] = {
                        userId: acc.userId,
                        ok: false,
                        error: err instanceof Error ? err.message : String(err),
                        gmailAddress: acc.gmailAddress,
                    };
                }
            }
        };
        const concurrency = Math.min(4, accounts.length);
        await Promise.all(Array.from({ length: concurrency }, () => worker()));

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
