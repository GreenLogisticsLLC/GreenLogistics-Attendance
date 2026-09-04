import { google } from "googleapis";
import { prisma } from "../../../config/database.js";
import {
    brokerGmailOAuthService,
} from "./broker-gmail-oauth.service.js";
import type { RawEmailMessage } from "../models/types.js";
import { applyUshipLifecycleEvent } from "../parsers/uship/uship-lifecycle.detector.js";
import {
    canonicalUshipListingUrl,
    followUshipToListingUrl,
    listingIdFromText,
    listingIdsFromText,
    trackingUrlsFromText,
} from "../parsers/uship/listing-url.js";
import {
    normalizeUshipTitle,
    titlesFromQuestionAnsweredEmail,
} from "../parsers/uship/uship-qa-match.js";

const USHIP_QUERY =
    "from:(uship.com OR email.uship.com OR notifications.uship.com OR mail.uship.com) newer_than:21d";

const CUSTOMER_REPLY_REMATCH =
    /quote|bid\s+confirmation|bid\s+submitted|submitted\s+a\s+(?:quote|bid)|customer\s+respond|respond\s+to\s+question|customer\s+replied|new\s+message|question\s+answered|answered\s+your\s+question|a\s+customer\s+has\s+answered/i;

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

function collectListingIds(...blobs: Array<string | null | undefined>): string[] {
    return listingIdsFromText(...blobs);
}

async function extractUshipRefs(input: {
    subject?: string | null;
    bodyText?: string | null;
    bodyHtml?: string | null;
    snippet?: string | null;
}): Promise<{ listingIds: string[]; externalId?: string; viewUrl?: string }> {
    const listingIds = new Set(
        collectListingIds(input.subject, input.bodyHtml, input.bodyText, input.snippet)
    );

    // Question Answered / Q&A emails often wrap the listing behind track.uship.com.
    if (!listingIds.size) {
        const tracks = trackingUrlsFromText(
            input.bodyHtml,
            input.bodyText,
            input.snippet,
            input.subject
        );
        for (const track of tracks.slice(0, 3)) {
            const resolved = await followUshipToListingUrl(track).catch(() => null);
            const id = resolved ? listingIdFromText(resolved) : null;
            if (id) listingIds.add(id);
        }
    }

    const ids = [...listingIds];
    const externalId = ids.length === 1 ? ids[0] : undefined;
    return {
        listingIds: ids,
        externalId,
        viewUrl: externalId ? canonicalUshipListingUrl(externalId) : undefined,
    };
}

const STRONG_MATCH_METHODS = [
    "viewUrl",
    "externalShipmentId",
    "greenOsShipmentId",
    "listingTitle",
    "routeZip",
];

async function matchExactListing(
    externalId: string,
    userId: string
): Promise<{ shipmentLeadId: string; assignedBrokerId: string | null } | null> {
    const id = String(externalId || "").replace(/\D/g, "");
    if (!id) return null;
    const rows = await prisma.shipmentLead.findMany({
        where: {
            assignedBrokerId: userId,
            OR: [
                { externalShipmentId: id },
                { source: "USHIP", externalShipmentId: id },
                { viewUrl: { contains: `/listing/${id}` } },
                // Instant Alert cards: https://www.uship.com/shipment/{slug}/{id}/
                { viewUrl: { contains: `/${id}/` } },
                { viewUrl: { endsWith: `/${id}` } },
            ],
        },
        select: {
            shipmentLeadId: true,
            assignedBrokerId: true,
            viewUrl: true,
            externalShipmentId: true,
        },
        take: 12,
    });
    const matched = rows.filter((row) => {
        if (String(row.externalShipmentId || "") === id) return true;
        const view = String(row.viewUrl || "");
        if (!view) return false;
        if (view.includes(`/listing/${id}`)) return true;
        if (new RegExp(`uship\\.com/shipment/[^/?#]+/${id}(?:/|$|[?#])`, "i").test(view)) {
            return true;
        }
        return view.includes(`/${id}/`) || view.endsWith(`/${id}`);
    });
    const unique = [...new Map(matched.map((r) => [r.shipmentLeadId, r])).values()];
    if (unique.length !== 1) return null;
    return unique[0];
}

async function openBrokerLeads(userId: string) {
    return prisma.shipmentLead.findMany({
        where: {
            assignedBrokerId: userId,
            status: {
                notIn: [
                    "CLOSED",
                    "LOST",
                    "DELETED_FROM_CUSTOMER",
                    "ACCEPTED_ANOTHER_COMPANY",
                    "COMPLETED",
                ],
            },
        },
        select: {
            shipmentLeadId: true,
            assignedBrokerId: true,
            shipmentTitle: true,
            pickupCity: true,
            deliveryCity: true,
            pickupZip: true,
            deliveryZip: true,
        },
        take: 250,
    });
}

async function matchByUniqueTitle(
    userId: string,
    subject: string,
    body: string
): Promise<{ shipmentLeadId: string; assignedBrokerId: string | null } | null> {
    const hay = normalizeUshipTitle(`${subject}\n${body.slice(0, 2500)}`);
    if (hay.length < 10) return null;
    const hinted = titlesFromQuestionAnsweredEmail(subject, body);
    const leads = await openBrokerLeads(userId);

    if (hinted.length) {
        const exact = leads.filter((lead) => {
            const title = normalizeUshipTitle(String(lead.shipmentTitle || ""));
            return title.length >= 4 && hinted.includes(title);
        });
        if (exact.length === 1) return exact[0];
    }

    const hits = leads.filter((lead) => {
        const title = normalizeUshipTitle(String(lead.shipmentTitle || ""));
        return title.length >= 8 && hay.includes(title);
    });
    if (hits.length !== 1) return null;
    return hits[0];
}

async function matchByUniqueRoute(
    userId: string,
    subject: string,
    body: string
): Promise<{ shipmentLeadId: string; assignedBrokerId: string | null } | null> {
    const hay = `${subject}\n${body}`.toLowerCase();
    const leads = await openBrokerLeads(userId);
    const hits = leads.filter((lead) => {
        const pz = String(lead.pickupZip || "").trim();
        const dz = String(lead.deliveryZip || "").trim();
        if (pz.length >= 5 && dz.length >= 5) {
            return hay.includes(pz) && hay.includes(dz);
        }
        const pc = String(lead.pickupCity || "").trim().toLowerCase();
        const dc = String(lead.deliveryCity || "").trim().toLowerCase();
        if (pc.length >= 3 && dc.length >= 3) {
            return hay.includes(pc) && hay.includes(dc);
        }
        return false;
    });
    if (hits.length !== 1) return null;
    return hits[0];
}

async function matchShipment(input: {
    userId: string;
    brokerGmailId: string;
    gmailThreadId?: string;
    externalId?: string;
    listingIds?: string[];
    viewUrl?: string;
    subject: string;
    body: string;
}): Promise<{ shipmentLeadId: string; method: string } | null> {
    let candidate: { shipmentLeadId: string; assignedBrokerId: string | null } | null = null;
    let method = "";

    const viewListingId = (() => {
        if (!input.viewUrl) return undefined;
        const listing = input.viewUrl.match(/\/(?:listing|l)\/(\d{6,12})/i)?.[1];
        if (listing) return listing;
        return input.viewUrl.match(/\/shipment\/[^/?#]+\/(\d{6,12})/i)?.[1];
    })();

    const listingIds = [
        ...new Set(
            [input.externalId, ...(input.listingIds || []), viewListingId].filter(
                (id): id is string => Boolean(id)
            )
        ),
    ];

    const listingHits: Array<{ shipmentLeadId: string; assignedBrokerId: string | null }> = [];
    for (const listingId of listingIds) {
        const hit = await matchExactListing(listingId, input.userId);
        if (hit) listingHits.push(hit);
    }
    const uniqueListings = [
        ...new Map(listingHits.map((h) => [h.shipmentLeadId, h])).values(),
    ];
    if (uniqueListings.length === 1) {
        candidate = uniqueListings[0];
        method = input.viewUrl || input.externalId ? "viewUrl" : "externalShipmentId";
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
                matchMethod: { in: STRONG_MATCH_METHODS },
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

    if (!candidate) {
        candidate = await matchByUniqueTitle(input.userId, input.subject, input.body);
        if (candidate) method = "listingTitle";
    }

    if (!candidate) {
        candidate = await matchByUniqueRoute(input.userId, input.subject, input.body);
        if (candidate) method = "routeZip";
    }

    // Hard routing boundary: a broker mailbox can update only that broker's assigned Shipment.
    if (!candidate || candidate.assignedBrokerId !== input.userId) return null;
    return { shipmentLeadId: candidate.shipmentLeadId, method };
}

export class BrokerGmailSyncService {
    private clientFor(account: { brokerGmailId: string; refreshToken: string }) {
        const oauth2 = brokerGmailOAuthService.getSharedAuthedClient(account);
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
                const refs = await extractUshipRefs({
                    subject: row.subject,
                    bodyText: body,
                    snippet: row.snippet,
                });
                const match = await matchShipment({
                    userId: account.userId,
                    brokerGmailId: account.brokerGmailId,
                    gmailThreadId: row.gmailThreadId || undefined,
                    externalId: refs.externalId,
                    listingIds: refs.listingIds,
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

            const looksQuoteOrBid = CUSTOMER_REPLY_REMATCH.test(`${row.subject}\n${body}`);
            // Re-apply for newly matched rows, or quote/bid / Question Answered that may have been UNKNOWN before.
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
        const gmail = this.clientFor(account);
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
                            const refs = await extractUshipRefs({
                                subject: existing.subject,
                                bodyText: body,
                                snippet: existing.snippet,
                            });
                            const match = await matchShipment({
                                userId: account.userId,
                                brokerGmailId: account.brokerGmailId,
                                gmailThreadId: existing.gmailThreadId || undefined,
                                externalId: refs.externalId,
                                listingIds: refs.listingIds,
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
                    const bodyHtmlPlain = raw.bodyHtml ? stripHtml(raw.bodyHtml) : "";
                    const body = `${bodyText}\n${bodyHtmlPlain}\n${raw.snippet || ""}`;

                    if (!isUshipRelated(raw.fromAddress, raw.subject, body)) {
                        ignored += 1;
                        continue;
                    }

                    // Pull listing IDs from raw HTML hrefs before stripHtml removes them.
                    // Also follow track.uship.com wrappers used by Question Answered emails.
                    const refs = await extractUshipRefs({
                        subject: raw.subject,
                        bodyText,
                        bodyHtml: raw.bodyHtml,
                        snippet: raw.snippet,
                    });
                    const match = await matchShipment({
                        userId: account.userId,
                        brokerGmailId: account.brokerGmailId,
                        gmailThreadId: raw.gmailThreadId,
                        externalId: refs.externalId,
                        listingIds: refs.listingIds,
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
            const hint = reconnect
                ? " invalid_grant — Google revoked the refresh token (often OAuth app still in Testing: tokens expire ~7 days). Publish OAuth consent screen to Production, then Reconnect Gmail once."
                : "";
            console.warn(
                `[broker-gmail] sync failed for ${account.gmailAddress}: ${message.slice(0, 200)}` +
                    (reconnect ? " → RECONNECT_REQUIRED" : "")
            );
            brokerGmailOAuthService.invalidateBrokerClient(account.brokerGmailId);
            await prisma.brokerGmailAccount.update({
                where: { brokerGmailId: account.brokerGmailId },
                data: {
                    lastError: (reconnect ? hint.trim() : message).slice(0, 500),
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

    /** Full HTML/text of broker uShip emails for this card — listing links live in HTML, not snippets. */
    async listingSourceBlobsForShipment(shipmentLeadId: string): Promise<string[]> {
        const rows = await prisma.brokerMailboxMessage.findMany({
            where: { shipmentLeadId },
            orderBy: { receivedAt: "asc" },
            take: 8,
            select: {
                messageId: true,
                gmailMessageId: true,
                userId: true,
                subject: true,
                snippet: true,
                bodyText: true,
            },
        });
        if (!rows.length) return [];

        const blobs: string[] = [];
        const byUser = new Map<string, typeof rows>();
        for (const row of rows) {
            blobs.push(row.subject, row.snippet || "", row.bodyText || "");
            const list = byUser.get(row.userId) || [];
            list.push(row);
            byUser.set(row.userId, list);
        }

        for (const [userId, userRows] of byUser) {
            const account = await prisma.brokerGmailAccount.findFirst({
                where: { userId, isActive: true, status: "CONNECTED" },
                select: { brokerGmailId: true, refreshToken: true },
            });
            if (!account) continue;
            try {
                const gmail = this.clientFor(account);
                for (const row of userRows) {
                    if (listingIdsFromText(row.bodyText, row.snippet, row.subject).length) continue;
                    const raw = await this.fetchRaw(gmail, row.gmailMessageId);
                    blobs.push(raw.subject, raw.snippet || "", raw.bodyText || "", raw.bodyHtml || "");
                    if (raw.bodyText && raw.bodyText !== row.bodyText) {
                        await prisma.brokerMailboxMessage
                            .update({
                                where: { messageId: row.messageId },
                                data: { bodyText: raw.bodyText.slice(0, 20000) },
                            })
                            .catch(() => null);
                    }
                }
            } catch {
                /* broker Gmail re-read is best-effort */
            }
        }
        return blobs;
    }

    /**
     * Instant Alerts often never get linked to the card. Search the assigned broker's
     * Gmail by pickup/delivery and return the best-matching message bodies.
     */
    async searchListingBlobsForLead(lead: {
        assignedBrokerId: string | null;
        pickupCity: string | null;
        deliveryCity: string | null;
        pickupZip: string | null;
        deliveryZip: string | null;
        shipmentTitle: string | null;
        miles: number | null;
    }): Promise<string[]> {
        if (!lead.assignedBrokerId) return [];
        const account = await prisma.brokerGmailAccount.findFirst({
            where: {
                userId: lead.assignedBrokerId,
                isActive: true,
                status: "CONNECTED",
            },
            select: { brokerGmailId: true, refreshToken: true },
        });
        if (!account) return [];

        const terms = ["from:(uship.com OR email.uship.com OR mail.uship.com)", "newer_than:30d"];
        if (lead.deliveryCity) terms.push(`"${lead.deliveryCity}"`);
        else if (lead.pickupCity) terms.push(`"${lead.pickupCity}"`);
        if (lead.deliveryZip) terms.push(lead.deliveryZip);
        const q = terms.join(" ");

        try {
            const gmail = this.clientFor(account);
            const list = await gmail.users.messages.list({
                userId: "me",
                q,
                maxResults: 12,
            });
            const scored: Array<{ score: number; blobs: string[] }> = [];
            for (const msg of list.data.messages || []) {
                if (!msg.id) continue;
                const raw = await this.fetchRaw(gmail, msg.id);
                const hay = `${raw.subject}\n${raw.snippet || ""}\n${raw.bodyText || ""}\n${raw.bodyHtml || ""}`.toLowerCase();
                let score = 0;
                if (lead.deliveryCity && hay.includes(lead.deliveryCity.toLowerCase())) score += 4;
                if (lead.pickupCity && hay.includes(lead.pickupCity.toLowerCase())) score += 4;
                if (lead.deliveryZip && hay.includes(lead.deliveryZip)) score += 3;
                if (lead.pickupZip && hay.includes(lead.pickupZip)) score += 3;
                if (lead.miles && hay.includes(String(Math.round(lead.miles)))) score += 2;
                if (lead.shipmentTitle) {
                    const title = lead.shipmentTitle.toLowerCase().slice(0, 24);
                    if (title.length >= 4 && hay.includes(title)) score += 2;
                }
                if (listingIdsFromText(raw.bodyHtml, raw.bodyText, raw.subject).length) score += 3;
                scored.push({
                    score,
                    blobs: [raw.subject, raw.snippet || "", raw.bodyText || "", raw.bodyHtml || ""],
                });
            }
            scored.sort((a, b) => b.score - a.score);
            const best = scored.filter((row) => row.score >= 4).slice(0, 3);
            return best.flatMap((row) => row.blobs);
        } catch {
            return [];
        }
    }
}

export const brokerGmailSyncService = new BrokerGmailSyncService();
