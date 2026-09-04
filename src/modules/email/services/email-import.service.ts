import { gmailListener } from "../gmail/gmail.listener.js";
import { parserFactory } from "../parsers/parser.factory.js";
import {
    emailMessageRepository,
    shipmentImportLogRepository,
    shipmentLeadRepository,
} from "./repositories.js";
import { shipmentLeadService } from "./shipment-lead.service.js";
import {
    applyUshipLifecycleEvent,
    detectUshipLifecycleEvent,
} from "../parsers/uship/uship-lifecycle.detector.js";
import { prisma } from "../../../config/database.js";
import { config } from "../../../config/env.js";
import { getCompanyImportAfter } from "./gmail-import-cutoff.service.js";
import { canonicalUshipListingUrl, listingIdsFromText, resolveConcreteUshipListing } from "../parsers/uship/listing-url.js";
import {
    normalizeUshipTitle,
    titlesFromQuestionAnsweredEmail,
} from "../parsers/uship/uship-qa-match.js";

function collectListingIds(...blobs: Array<string | null | undefined>): string[] {
    return listingIdsFromText(...blobs);
}

function extractUshipRefs(input: {
    subject?: string | null;
    bodyText?: string | null;
    bodyHtml?: string | null;
    snippet?: string | null;
}): { externalId?: string; viewUrl?: string; listingIds: string[] } {
    const ids = collectListingIds(input.subject, input.bodyHtml, input.bodyText, input.snippet);
    const externalId = ids.length === 1 ? ids[0] : undefined;
    return {
        listingIds: ids,
        externalId,
        viewUrl: externalId ? canonicalUshipListingUrl(externalId) : undefined,
    };
}

async function findShipmentForLifecycle(input: {
    subject?: string | null;
    bodyText?: string | null;
    bodyHtml?: string | null;
    snippet?: string | null;
}) {
    const refs = extractUshipRefs(input);
    for (const listingId of refs.listingIds) {
        const byExt = await shipmentLeadRepository.findByExternalId("USHIP", listingId);
        if (byExt) return byExt;
        const byView = await prisma.shipmentLead.findFirst({
            where: {
                OR: [
                    { viewUrl: { contains: `/listing/${listingId}` } },
                    { viewUrl: { contains: `/${listingId}/` } },
                    { externalShipmentId: listingId },
                ],
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
        });
        if (byView) return byView;
    }
    if (refs.viewUrl) {
        const byUrl = await shipmentLeadRepository.findByViewUrl(refs.viewUrl);
        if (byUrl) return byUrl;
    }
    if (refs.externalId) {
        const byExt = await shipmentLeadRepository.findByExternalId("USHIP", refs.externalId);
        if (byExt) return byExt;
    }
    const text = [input.subject, input.bodyText, input.bodyHtml, input.snippet]
        .filter(Boolean)
        .join("\n");
    const gosSeq = text.match(/\bGOS(\d{7,})\b/i);
    if (gosSeq) {
        return prisma.shipmentLead.findUnique({
            where: { greenOsShipmentId: `GOS${gosSeq[1]}` },
        });
    }
    const gosLegacy = text.match(/GOS-\d{8}-\d+/i);
    if (gosLegacy) {
        return prisma.shipmentLead.findUnique({
            where: { greenOsShipmentId: gosLegacy[0].toUpperCase() },
        });
    }

    // Question Answered emails often omit listing IDs — match unique title / route.
    const hinted = titlesFromQuestionAnsweredEmail(String(input.subject || ""), text);
    const open = await prisma.shipmentLead.findMany({
        where: {
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
            pickupZip: true,
            deliveryZip: true,
            pickupCity: true,
            deliveryCity: true,
            greenOsShipmentId: true,
            externalShipmentId: true,
            viewUrl: true,
            status: true,
            source: true,
        },
        take: 400,
    });
    if (hinted.length) {
        const titleHits = open.filter((lead) => {
            const title = normalizeUshipTitle(String(lead.shipmentTitle || ""));
            return title.length >= 4 && hinted.includes(title);
        });
        if (titleHits.length === 1) {
            return prisma.shipmentLead.findUnique({
                where: { shipmentLeadId: titleHits[0].shipmentLeadId },
            });
        }
    }
    const hay = text.toLowerCase();
    const routeHits = open.filter((lead) => {
        const pz = String(lead.pickupZip || "").trim();
        const dz = String(lead.deliveryZip || "").trim();
        if (pz.length >= 5 && dz.length >= 5) return hay.includes(pz) && hay.includes(dz);
        const pc = String(lead.pickupCity || "").trim().toLowerCase();
        const dc = String(lead.deliveryCity || "").trim().toLowerCase();
        if (pc.length >= 3 && dc.length >= 3) return hay.includes(pc) && hay.includes(dc);
        return false;
    });
    if (routeHits.length === 1) {
        return prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: routeHits[0].shipmentLeadId },
        });
    }
    return null;
}

export class EmailImportService {
    private assertCompanyImportMailbox(): { ok: true } | { ok: false; message: string } {
        const required = (config.companyUshipImportEmail || "").trim().toLowerCase();
        if (!required) return { ok: true };
        const connected = (config.gmail.user || "").trim().toLowerCase();
        if (!connected) {
            return {
                ok: false,
                message: `Company Gmail not connected. Connect ${required} in Email Imports.`,
            };
        }
        if (connected !== required) {
            return {
                ok: false,
                message: `Connected mailbox is ${connected}, but new shipments must come from ${required}. Reconnect Company Gmail as ${required}.`,
            };
        }
        return { ok: true };
    }

    async checkInbox(options?: { maxMessages?: number }) {
        if (!(await gmailListener.ensureCredentials())) {
            return {
                configured: false,
                processed: 0,
                imported: 0,
                ignored: 0,
                duplicates: 0,
                errors: 0,
                message:
                    "Gmail is not connected. Open /api/email/auth (after setting GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET), or set GMAIL_REFRESH_TOKEN.",
            };
        }

        const mailboxCheck = this.assertCompanyImportMailbox();
        if (!mailboxCheck.ok) {
            console.warn(`[email-import] ${mailboxCheck.message}`);
            return {
                configured: true,
                processed: 0,
                imported: 0,
                ignored: 0,
                duplicates: 0,
                errors: 1,
                message: mailboxCheck.message,
            };
        }

        const importAfter = await getCompanyImportAfter();
        const ids = await gmailListener.listUnreadMessageIds(options?.maxMessages ?? 25, {
            after: importAfter,
        });
        let imported = 0;
        let ignored = 0;
        let duplicates = 0;
        let errors = 0;
        let skippedBeforeCutoff = 0;

        for (const gmailMessageId of ids) {
            try {
                const existing = await emailMessageRepository.findByGmailId(gmailMessageId);
                if (existing) {
                    await gmailListener.markProcessed(gmailMessageId);
                    duplicates += 1;
                    await shipmentImportLogRepository.create({
                        eventType: "DuplicateShipment",
                        message: `Gmail MessageID already processed: ${gmailMessageId}`,
                        gmailMessageId,
                        emailMessageId: existing.emailMessageId,
                    });
                    continue;
                }

                const raw = await gmailListener.fetchMessage(gmailMessageId);
                if (importAfter && raw.receivedAt.getTime() < importAfter.getTime()) {
                    await gmailListener.markProcessed(gmailMessageId);
                    skippedBeforeCutoff += 1;
                    await shipmentImportLogRepository.create({
                        eventType: "SkippedBeforeCutoff",
                        message: `Skipped old Gmail before import_after ${importAfter.toISOString()}: ${raw.subject}`,
                        gmailMessageId,
                    });
                    continue;
                }

                const stored = await emailMessageRepository.create({
                    gmailMessageId: raw.gmailMessageId,
                    gmailThreadId: raw.gmailThreadId,
                    fromAddress: raw.fromAddress,
                    subject: raw.subject,
                    snippet: raw.snippet,
                    receivedAt: raw.receivedAt,
                    processStatus: "PROCESSING",
                    bodyText: raw.bodyText,
                    bodyHtml: raw.bodyHtml,
                    rawHeaders: raw.rawHeaders,
                });

                const parser = parserFactory.resolve(raw);
                if (!parser) {
                    // Sprint D — uShip lifecycle emails (bid/reply/accept/load) on company inbox
                    const from = (raw.fromAddress || "").toLowerCase();
                    if (from.includes("uship.com")) {
                        const existingShipment = await findShipmentForLifecycle({
                            subject: raw.subject,
                            bodyText: raw.bodyText,
                            bodyHtml: raw.bodyHtml,
                            snippet: raw.snippet,
                        });
                        if (existingShipment) {
                            const blob = `${raw.subject}\n${raw.bodyText || ""}\n${raw.bodyHtml || ""}\n${raw.snippet || ""}`;
                            const detected = detectUshipLifecycleEvent(raw.subject, blob);
                            const customerReplyKinds = new Set([
                                "CUSTOMER_RESPOND",
                                "CUSTOMER_QUESTION",
                                "CUSTOMER_REPLIED",
                                "NEW_MESSAGE",
                            ]);
                            // After assignment, ignore most company-inbox follow-ups — but still
                            // apply Question Answered / customer replies so the red lamp lights.
                            if (
                                existingShipment.assignedBrokerId &&
                                !customerReplyKinds.has(detected.kind)
                            ) {
                                await emailMessageRepository.markProcessed(
                                    stored.emailMessageId,
                                    "IGNORED",
                                    "USHIP"
                                );
                                await shipmentImportLogRepository.create({
                                    eventType: "EmailIgnored",
                                    message:
                                        `Ignored company Gmail follow-up after assignment; ` +
                                        `use assigned broker Gmail: ${raw.subject}`,
                                    gmailMessageId,
                                    emailMessageId: stored.emailMessageId,
                                    shipmentLeadId: existingShipment.shipmentLeadId,
                                });
                                await gmailListener.markProcessed(gmailMessageId);
                                ignored += 1;
                                continue;
                            }

                            const lifecycle = await applyUshipLifecycleEvent({
                                shipmentLeadId: existingShipment.shipmentLeadId,
                                subject: raw.subject,
                                body: blob,
                                gmailMessageId,
                                actorUserId: existingShipment.assignedBrokerId || undefined,
                                source: "company_gmail",
                            });
                            await emailMessageRepository.markProcessed(
                                stored.emailMessageId,
                                lifecycle.applied ? "LIFECYCLE" : "IGNORED",
                                "USHIP"
                            );
                            await shipmentImportLogRepository.create({
                                eventType: lifecycle.applied ? "PipelineEvent" : "EmailIgnored",
                                message: lifecycle.applied
                                    ? `Lifecycle update from company Gmail: ${raw.subject}`
                                    : `Company Gmail lifecycle skipped: ${
                                          "reason" in lifecycle
                                              ? lifecycle.reason
                                              : "not applied"
                                      }`,
                                gmailMessageId,
                                emailMessageId: stored.emailMessageId,
                                shipmentLeadId: existingShipment.shipmentLeadId,
                            });
                            await gmailListener.markProcessed(gmailMessageId);
                            if (lifecycle.applied) imported += 1;
                            else ignored += 1;
                            continue;
                        }
                    }

                    await emailMessageRepository.markProcessed(
                        stored.emailMessageId,
                        "IGNORED"
                    );
                    await shipmentImportLogRepository.create({
                        eventType: "EmailIgnored",
                        message: `Ignored non-uShip email from ${raw.fromAddress}: ${raw.subject}`,
                        gmailMessageId,
                        emailMessageId: stored.emailMessageId,
                    });
                    await gmailListener.markProcessed(gmailMessageId);
                    ignored += 1;
                    continue;
                }

                const draft = parser.parse(raw);
                if (!draft) {
                    await emailMessageRepository.markProcessed(
                        stored.emailMessageId,
                        "PARSE_ERROR",
                        parser.source
                    );
                    await shipmentImportLogRepository.create({
                        eventType: "ParseError",
                        message: `Failed to parse ${parser.source} email: ${raw.subject}`,
                        gmailMessageId,
                        emailMessageId: stored.emailMessageId,
                    });
                    await gmailListener.markProcessed(gmailMessageId);
                    errors += 1;
                    continue;
                }

                // Every USHIP card must store the concrete listing/shipment URL from this email.
                if (draft.source === "USHIP") {
                    const bound = await resolveConcreteUshipListing(
                        draft.viewUrl,
                        raw.bodyHtml,
                        raw.bodyText,
                        raw.subject,
                        raw.snippet
                    );
                    if (bound) {
                        draft.viewUrl = bound.viewUrl;
                        draft.externalShipmentId = bound.externalShipmentId;
                    } else {
                        await shipmentImportLogRepository.create({
                            eventType: "MissingUshipUrl",
                            message: `No concrete uShip URL for: ${raw.subject}`,
                            gmailMessageId,
                            emailMessageId: stored.emailMessageId,
                        });
                    }
                }

                const result = await shipmentLeadService.createFromParsed({
                    draft,
                    emailMessageId: stored.emailMessageId,
                    gmailMessageId,
                });

                await emailMessageRepository.markProcessed(
                    stored.emailMessageId,
                    result.duplicate ? "DUPLICATE" : "IMPORTED",
                    parser.source
                );
                await gmailListener.markProcessed(gmailMessageId);

                if (result.duplicate) duplicates += 1;
                else imported += 1;
            } catch (err) {
                errors += 1;
                const message = err instanceof Error ? err.message : "Unknown import error";
                await shipmentImportLogRepository.create({
                    eventType: "ParseError",
                    message: `Import failed for ${gmailMessageId}: ${message}`,
                    gmailMessageId,
                });
                try {
                    await gmailListener.markProcessed(gmailMessageId);
                } catch {
                    /* leave unread for retry if mark fails */
                }
            }
        }

        // Timeouts still pass waiting leads. Do not drain old Other backlog here —
        // only leftover fresh NEW imports that were parked with no broker.
        await shipmentLeadService.assignment.processDueAcceptances();
        const drained = await shipmentLeadService.assignment.assignPendingNewLeads(8);
        if (drained > 0) {
            console.log(`[email] drained ${drained} pending shipment(s) to In Office brokers`);
        }

        return {
            configured: true,
            processed: ids.length,
            imported,
            ignored,
            duplicates,
            errors,
            skippedBeforeCutoff,
            drained,
            importAfter: importAfter?.toISOString() || null,
            message: `Processed ${ids.length} unread message(s)`,
        };
    }
}

export const emailImportService = new EmailImportService();
