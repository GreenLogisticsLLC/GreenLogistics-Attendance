import { gmailListener } from "../gmail/gmail.listener.js";
import { parserFactory } from "../parsers/parser.factory.js";
import {
    emailMessageRepository,
    shipmentImportLogRepository,
    shipmentLeadRepository,
} from "./repositories.js";
import { shipmentLeadService } from "./shipment-lead.service.js";
import { applyUshipLifecycleEvent } from "../parsers/uship/uship-lifecycle.detector.js";
import { prisma } from "../../../config/database.js";
import { config } from "../../../config/env.js";
import { getCompanyImportAfter } from "./gmail-import-cutoff.service.js";

function collectListingIds(...blobs: Array<string | null | undefined>): string[] {
    const ids = new Set<string>();
    for (const blob of blobs) {
        const text = String(blob || "");
        for (const match of text.matchAll(/\/listing\/(\d{5,})(?:\/|[?#"'<\s>]|$)/gi)) {
            if (match[1]) ids.add(match[1]);
        }
        for (const match of text.matchAll(
            /(?:listing|shipment)\s*(?:id|#|number)?\s*[:#]?\s*(\d{5,})/gi
        )) {
            if (match[1]) ids.add(match[1]);
        }
    }
    return [...ids];
}

function extractUshipRefs(input: {
    subject?: string | null;
    bodyText?: string | null;
    bodyHtml?: string | null;
    snippet?: string | null;
}): { externalId?: string; viewUrl?: string } {
    const ids = collectListingIds(input.subject, input.bodyHtml, input.bodyText, input.snippet);
    if (ids.length !== 1) return {};
    const externalId = ids[0];
    return {
        externalId,
        viewUrl: `https://www.uship.com/listing/${externalId}`,
    };
}

async function findShipmentForLifecycle(input: {
    subject?: string | null;
    bodyText?: string | null;
    bodyHtml?: string | null;
    snippet?: string | null;
}) {
    const refs = extractUshipRefs(input);
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
                            if (existingShipment.assignedBrokerId) {
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

                            const blob = `${raw.subject}\n${raw.bodyText || ""}\n${raw.bodyHtml || ""}\n${raw.snippet || ""}`;
                            const lifecycle = await applyUshipLifecycleEvent({
                                shipmentLeadId: existingShipment.shipmentLeadId,
                                subject: raw.subject,
                                body: blob,
                                gmailMessageId,
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
