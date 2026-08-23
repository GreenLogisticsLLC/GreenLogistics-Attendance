import { assertShipmentAccessOrThrow } from "../../../auth/access.js";
import { prisma } from "../../../config/database.js";
import { carrierService } from "../../carriers/services/carrier.service.js";
import { classifyResponse, extractCommitment } from "./classify.js";
import { classifyDirection, communicationParticipant } from "./direction.js";
import { communicationPriority } from "./priority.js";
import type {
    CommunicationContext,
    CommunicationMessage,
    CommunicationRecommendation,
    CommunicationSource,
} from "./types.js";
import { computeWaitingState } from "./waiting.js";

export type CommunicationActor = { userId: string; role: string };

function snippet(value: unknown): string {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 200);
}

function payload(raw: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function normalizeDocType(value: unknown): string {
    const type = String(value || "").toUpperCase().replace(/[\s-]+/g, "_");
    if (type === "AUTHORITY") return "MC_AUTHORITY";
    if (type === "BROKER_CARRIER_AGREEMENT") return "AGREEMENT";
    return type;
}

function contact(message: CommunicationMessage | undefined) {
    return message
        ? {
              at: message.at,
              direction: message.direction,
              participant: message.participant,
              subject: message.subject,
              messageId: message.id,
          }
        : null;
}

export class CommunicationService {
    async carrierCommunications(
        actor: CommunicationActor,
        carrierId: string
    ): Promise<CommunicationContext> {
        await carrierService.assertCarrierAccess(carrierId, actor);
        const carrier = await prisma.carrier.findUnique({
            where: { carrierId },
            select: {
                carrierId: true,
                legalName: true,
                email: true,
                assignedBrokerId: true,
            },
        });
        if (!carrier) throw Object.assign(new Error("Carrier not found"), { status: 404 });
        const shipments = await prisma.shipmentLead.findMany({
            where: { carrierProfileId: carrierId },
            select: {
                shipmentLeadId: true,
                carrierEmail: true,
                customerEmail: true,
                assignedBrokerId: true,
                status: true,
                updatedAt: true,
            },
            take: 100,
        });
        return this.build(actor, {
            entityType: "carrier",
            entityId: carrierId,
            carrierId,
            carrierName: carrier.legalName,
            carrierEmails: [carrier.email, ...shipments.map((s) => s.carrierEmail)],
            customerEmails: shipments.map((s) => s.customerEmail),
            brokerIds: [carrier.assignedBrokerId, ...shipments.map((s) => s.assignedBrokerId)],
            shipmentIds: shipments.map((s) => s.shipmentLeadId),
            shipmentStatus: null,
            shipmentUpdatedAt: null,
        });
    }

    async shipmentCommunications(
        actor: CommunicationActor,
        shipmentLeadId: string
    ): Promise<CommunicationContext> {
        let id = String(shipmentLeadId || "").trim();
        if (!id.includes("-") || id.length < 30) {
            const resolved = await prisma.shipmentLead.findFirst({
                where: {
                    OR: [
                        { loadNumber: id },
                        { greenOsShipmentId: id },
                        { externalShipmentId: id },
                    ],
                },
                select: { shipmentLeadId: true },
            });
            if (resolved) id = resolved.shipmentLeadId;
        }
        await assertShipmentAccessOrThrow(actor, id);
        const shipment = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: id },
            select: {
                shipmentLeadId: true,
                loadNumber: true,
                greenOsShipmentId: true,
                carrierProfileId: true,
                carrierName: true,
                carrierEmail: true,
                customerEmail: true,
                assignedBrokerId: true,
                status: true,
                updatedAt: true,
                carrierProfile: { select: { email: true } },
            },
        });
        if (!shipment) throw Object.assign(new Error("Shipment not found"), { status: 404 });
        return this.build(actor, {
            entityType: "shipment",
            entityId: id,
            carrierId: shipment.carrierProfileId,
            carrierName: shipment.carrierName,
            carrierEmails: [shipment.carrierEmail, shipment.carrierProfile?.email || null],
            customerEmails: [shipment.customerEmail],
            brokerIds: [shipment.assignedBrokerId],
            shipmentIds: [id],
            shipmentStatus: shipment.status,
            shipmentUpdatedAt: shipment.updatedAt,
        });
    }

    private async build(
        actor: CommunicationActor,
        seed: {
            entityType: "carrier" | "shipment";
            entityId: string;
            carrierId: string | null;
            carrierName: string | null;
            carrierEmails: Array<string | null>;
            customerEmails: Array<string | null>;
            brokerIds: Array<string | null>;
            shipmentIds: string[];
            shipmentStatus: string | null;
            shipmentUpdatedAt: Date | null;
        }
    ): Promise<CommunicationContext> {
        const incompleteContext: string[] = [];
        const brokerIds = [...new Set(seed.brokerIds.filter((v): v is string => Boolean(v)))];
        const brokerAccounts = brokerIds.length
            ? await prisma.brokerGmailAccount.findMany({
                  where: { userId: { in: brokerIds }, isActive: true },
                  select: { userId: true, gmailAddress: true },
              })
            : [];
        const brokerUsers = brokerIds.length
            ? await prisma.user.findMany({
                  where: { userId: { in: brokerIds } },
                  select: { userId: true, email: true },
              })
            : [];
        const brokerEmails = new Set(
            [...brokerAccounts.map((a) => a.gmailAddress), ...brokerUsers.map((u) => u.email)]
                .filter((v): v is string => Boolean(v))
                .map((v) => v.toLowerCase())
        );
        const carrierEmails = new Set(
            seed.carrierEmails.filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase())
        );
        const customerEmails = new Set(
            seed.customerEmails.filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase())
        );
        const directionContext = { brokerEmails, carrierEmails, customerEmails };

        const actionTargets = [
            ...(seed.carrierId ? [{ targetType: "carrier", targetId: seed.carrierId }] : []),
            ...seed.shipmentIds.map((id) => ({ targetType: "shipment", targetId: id })),
        ];
        const [mailbox, importer, actions, documents, jobs, domainEvents, timelineEvents, onboarding] =
            await Promise.all([
                seed.shipmentIds.length
                    ? prisma.brokerMailboxMessage.findMany({
                          where: {
                              shipmentLeadId: { in: seed.shipmentIds },
                              ...(actor.role === "Broker" ? { userId: actor.userId } : {}),
                          },
                          orderBy: { receivedAt: "desc" },
                          take: 40,
                          select: {
                              messageId: true,
                              gmailThreadId: true,
                              fromAddress: true,
                              subject: true,
                              snippet: true,
                              bodyText: true,
                              receivedAt: true,
                          },
                      })
                    : Promise.resolve([]),
                seed.shipmentIds.length
                    ? prisma.emailMessage.findMany({
                          where: { shipmentLeads: { some: { shipmentLeadId: { in: seed.shipmentIds } } } },
                          orderBy: { receivedAt: "desc" },
                          take: 10,
                          select: {
                              emailMessageId: true,
                              gmailThreadId: true,
                              fromAddress: true,
                              subject: true,
                              snippet: true,
                              bodyText: true,
                              receivedAt: true,
                          },
                      })
                    : Promise.resolve([]),
                actionTargets.length
                    ? prisma.aiAction.findMany({
                          where: {
                              OR: actionTargets,
                              status: "EXECUTED",
                              actionType: { in: ["SEND_EMAIL", "REQUEST_DOCUMENT"] },
                              ...(actor.role === "Broker" ? { actorUserId: actor.userId } : {}),
                          },
                          orderBy: { executedAt: "desc" },
                          take: 40,
                          select: {
                              actionId: true,
                              actionType: true,
                              status: true,
                              title: true,
                              payloadJson: true,
                              executedAt: true,
                          },
                      })
                    : Promise.resolve([]),
                seed.carrierId
                    ? prisma.carrierDocument.findMany({
                          where: {
                              carrierId: seed.carrierId,
                              status: "CURRENT",
                              ...(seed.entityType === "shipment"
                                  ? { OR: [{ shipmentLeadId: seed.entityId }, { shipmentLeadId: null }] }
                                  : {}),
                          },
                          orderBy: { uploadedAt: "desc" },
                          take: 60,
                          select: {
                              documentId: true,
                              documentType: true,
                              status: true,
                              uploadedAt: true,
                              originalFilename: true,
                          },
                      })
                    : Promise.resolve([]),
                prisma.aiDocumentJob.findMany({
                    where: {
                        OR: [
                            ...(seed.carrierId ? [{ carrierId: seed.carrierId }] : []),
                            ...seed.shipmentIds.map((shipmentLeadId) => ({ shipmentLeadId })),
                        ],
                        validation: { isNot: null },
                    },
                    orderBy: { createdAt: "desc" },
                    take: 30,
                    select: {
                        jobId: true,
                        createdAt: true,
                        extraction: { select: { signaturesJson: true } },
                        validation: {
                            select: {
                                validationId: true,
                                requiresReview: true,
                                overallStatus: true,
                                createdAt: true,
                            },
                        },
                    },
                }),
                seed.shipmentIds.length
                    ? prisma.domainEvent.findMany({
                          where: { shipmentLeadId: { in: seed.shipmentIds } },
                          orderBy: { createdAt: "desc" },
                          take: 30,
                          select: {
                              eventId: true,
                              eventType: true,
                              title: true,
                              message: true,
                              createdAt: true,
                          },
                      })
                    : Promise.resolve([]),
                seed.shipmentIds.length
                    ? prisma.shipmentTimelineEvent.findMany({
                          where: { shipmentLeadId: { in: seed.shipmentIds } },
                          orderBy: { createdAt: "desc" },
                          take: 30,
                          select: {
                              eventId: true,
                              stage: true,
                              title: true,
                              message: true,
                              createdAt: true,
                          },
                      })
                    : Promise.resolve([]),
                seed.carrierId
                    ? prisma.carrierOnboardingEvent.findMany({
                          where: {
                              carrierId: seed.carrierId,
                              ...(seed.entityType === "shipment"
                                  ? { OR: [{ shipmentLeadId: seed.entityId }, { shipmentLeadId: null }] }
                                  : {}),
                          },
                          orderBy: { createdAt: "desc" },
                          take: 30,
                          select: {
                              eventId: true,
                              action: true,
                              title: true,
                              message: true,
                              createdAt: true,
                          },
                      })
                    : Promise.resolve([]),
            ]);

        const messages: CommunicationMessage[] = [];
        for (const row of mailbox) {
            const participant = communicationParticipant(row.fromAddress, directionContext);
            const direction = classifyDirection(row.fromAddress, directionContext);
            messages.push({
                id: row.messageId,
                sourceType: "BROKER_MAILBOX",
                direction,
                participant: participant.participant,
                participantUncertain: participant.uncertain,
                subject: snippet(row.subject),
                snippet: snippet(row.snippet || row.bodyText),
                at: row.receivedAt.toISOString(),
                gmailThreadId: row.gmailThreadId,
                threadKey: row.gmailThreadId || `THREAD_UNCERTAIN:BROKER_MAILBOX:${row.messageId}`,
            });
        }
        for (const row of importer) {
            const participant = communicationParticipant(row.fromAddress, directionContext);
            const direction = classifyDirection(row.fromAddress, directionContext);
            messages.push({
                id: row.emailMessageId,
                sourceType: "EMAIL_MESSAGE",
                direction,
                participant: participant.participant,
                participantUncertain: participant.uncertain,
                subject: snippet(row.subject),
                snippet: snippet(row.snippet || row.bodyText),
                at: row.receivedAt.toISOString(),
                gmailThreadId: row.gmailThreadId,
                threadKey: row.gmailThreadId || `THREAD_UNCERTAIN:EMAIL_MESSAGE:${row.emailMessageId}`,
            });
        }
        for (const row of actions) {
            if (!row.executedAt) {
                incompleteContext.push(`Executed action ${row.actionId} has no executedAt timestamp.`);
                continue;
            }
            const data = payload(row.payloadJson);
            messages.push({
                id: row.actionId,
                sourceType: "AI_ACTION",
                direction: "OUTBOUND",
                participant: "CARRIER",
                subject: snippet(data.subject || row.title),
                snippet: snippet(data.bodyText || data.body),
                at: row.executedAt.toISOString(),
                gmailThreadId: null,
                threadKey: `THREAD_UNCERTAIN:AI_ACTION:${row.actionId}`,
                actionStatus: row.status,
            });
        }
        messages.sort((a, b) => b.at.localeCompare(a.at));

        const validations = jobs
            .map((j) =>
                j.validation
                    ? {
                          validationId: j.validation.validationId,
                          requiresReview: j.validation.requiresReview,
                          overallStatus: j.validation.overallStatus,
                          createdAt: j.validation.createdAt,
                      }
                    : null
            )
            .filter((v): v is NonNullable<typeof v> => Boolean(v));
        const missingSignature = jobs.some((j) => {
            if (!j.extraction?.signaturesJson) return false;
            try {
                const parsed = JSON.parse(j.extraction.signaturesJson);
                return (
                    Array.isArray(parsed) &&
                    parsed.some((s) => ["MISSING", "UNSIGNED"].includes(String(s?.status || "").toUpperCase()))
                );
            } catch {
                return false;
            }
        });
        const customerQuestionEvents = [...domainEvents, ...timelineEvents]
            .filter((e) => /\bcustomer\b/i.test(`${e.title} ${e.message || ""}`) && /\b(question|ask|request|reply)\b/i.test(`${e.title} ${e.message || ""}`))
            .map((e) => ({ id: e.eventId, at: e.createdAt, resolved: /\b(replied|answered|resolved)\b/i.test(`${e.title} ${e.message || ""}`) }));
        const waiting = computeWaitingState({
            actions: actions.map((a) => ({
                actionId: a.actionId,
                actionType: a.actionType,
                status: a.status,
                executedAt: a.executedAt,
                documentType: normalizeDocType(payload(a.payloadJson).documentType) || null,
            })),
            documents: documents.map((d) => ({
                documentId: d.documentId,
                documentType: normalizeDocType(d.documentType),
                status: d.status,
                uploadedAt: d.uploadedAt,
            })),
            validations,
            messages,
            shipmentStatus: seed.shipmentStatus,
            shipmentUpdatedAt: seed.shipmentUpdatedAt,
            customerQuestionEvents,
            missingSignature,
            incomplete: !messages.length && !actions.length,
        });

        const inbound = messages.filter((m) => m.direction === "INBOUND");
        const outbound = messages.filter((m) => m.direction === "OUTBOUND");
        const latestInbound = inbound[0];
        const latestResponse = classifyResponse(
            latestInbound ? `${latestInbound.subject} ${latestInbound.snippet}` : ""
        );
        const commitments = inbound.flatMap((message) => {
            const found = extractCommitment(`${message.subject} ${message.snippet}`);
            return found.subject
                ? [{ messageId: message.id, subject: found.subject, promisedDate: found.promisedDate, at: message.at }]
                : [];
        });
        const recommendations: CommunicationRecommendation[] = [];
        for (const request of waiting.openRequests) {
            if (request.documentType && request.lifecycle === "REQUESTED") {
                const doc = request.documentType.toLowerCase();
                recommendations.push({
                    id: `comm-followup-${doc}`,
                    text: `Follow up for ${request.documentType}`,
                    reason: `${request.documentType} was requested and has not been received`,
                    priority: communicationPriority({
                        shipmentStatus: seed.shipmentStatus,
                        missingDocumentTypes: [request.documentType],
                        waitingForResponse: true,
                    }),
                    source: request.actionId,
                });
            }
        }
        const presentDocumentTypes = new Set(
            documents.map((document) => normalizeDocType(document.documentType))
        );
        const alreadyRequestedTypes = new Set(
            waiting.openRequests
                .map((request) => request.documentType)
                .filter((value): value is string => Boolean(value))
        );
        const requiredTypes =
            seed.entityType === "carrier"
                ? ["COI", "NOA", "W9", "MC_AUTHORITY"]
                : ["DELIVERED", "COMPLETED", "CLOSED"].includes(
                        String(seed.shipmentStatus || "").toUpperCase()
                    )
                  ? ["POD"]
                  : [];
        for (const documentType of requiredTypes) {
            if (
                presentDocumentTypes.has(documentType) ||
                alreadyRequestedTypes.has(documentType)
            ) {
                continue;
            }
            recommendations.push({
                id: `req-${documentType.toLowerCase()}`,
                text: `Request ${documentType}`,
                reason: `No current ${documentType} is recorded`,
                priority: communicationPriority({
                    shipmentStatus: seed.shipmentStatus,
                    missingDocumentTypes: [documentType],
                }),
                source: seed.entityId,
            });
        }
        if (
            !recommendations.length &&
            ["WAITING_FOR_RESPONSE", "WAITING_FOR_CARRIER"].includes(waiting.waitingFor)
        ) {
            recommendations.push({
                id: "comm-followup-response",
                text: "Follow up on the latest outbound communication",
                reason: "No newer inbound response is recorded",
                priority: communicationPriority({
                    shipmentStatus: seed.shipmentStatus,
                    waitingForResponse: true,
                }),
                source: outbound[0]?.id,
            });
        }

        const sourceRows: CommunicationSource[] = [
            {
                type: seed.entityType,
                id: seed.entityId,
                label: seed.entityType === "carrier" ? seed.carrierName || seed.entityId : seed.entityId,
            },
            ...messages.map((m) => ({
                type: m.sourceType === "AI_ACTION" ? "ai_action" : "email",
                id: m.id,
                label: m.subject || "Communication",
                at: m.at,
            })),
            ...documents.map((d) => ({
                type: "carrier_document",
                id: d.documentId,
                label: `${d.documentType}: ${d.originalFilename}`,
                at: d.uploadedAt.toISOString(),
            })),
            ...validations.map((v) => ({
                type: "document_validation",
                id: v.validationId,
                label: v.overallStatus,
                at: v.createdAt.toISOString(),
            })),
            ...domainEvents.map((e) => ({
                type: "domain_event",
                id: e.eventId,
                label: e.title,
                at: e.createdAt.toISOString(),
            })),
            ...timelineEvents.map((e) => ({
                type: "shipment_timeline_event",
                id: e.eventId,
                label: e.title,
                at: e.createdAt.toISOString(),
            })),
            ...onboarding.map((e) => ({
                type: "carrier_onboarding_event",
                id: e.eventId,
                label: e.title,
                at: e.createdAt.toISOString(),
            })),
        ];
        const sourceKeys = new Set<string>();
        const sources = sourceRows.filter((s) => {
            const key = `${s.type}:${s.id}`;
            if (sourceKeys.has(key)) return false;
            sourceKeys.add(key);
            return true;
        });
        const threadMap = new Map<string, string[]>();
        for (const message of messages) {
            threadMap.set(message.threadKey, [...(threadMap.get(message.threadKey) || []), message.id]);
        }
        const empty = !messages.length && !actions.length;
        if (empty) incompleteContext.push("No linked messages or executed communication actions were found.");

        return {
            entityType: seed.entityType,
            entityId: seed.entityId,
            carrierId: seed.carrierId,
            shipmentLeadIds: seed.shipmentIds,
            communicationStatus: empty ? "INCOMPLETE" : incompleteContext.length ? "INCOMPLETE" : "ACTIVE",
            waitingFor: empty ? "INCOMPLETE" : waiting.waitingFor,
            waitingSince: waiting.waitingSince,
            openRequests: waiting.openRequests,
            unresolvedItems: waiting.unresolvedItems,
            messages,
            threads: Array.from(threadMap.entries()).map(([threadKey, messageIds]) => ({
                threadKey,
                messageIds,
                uncertain: threadKey.startsWith("THREAD_UNCERTAIN:"),
            })),
            commitments,
            lastContact: contact(messages[0]),
            lastInbound: contact(inbound[0]),
            lastOutbound: contact(outbound[0]),
            latestResponse,
            followUp: empty
                ? { needed: "UNCERTAIN", reason: "No communication evidence is linked." }
                : recommendations.length
                  ? { needed: "YES", reason: recommendations[0].reason }
                  : { needed: "NO", reason: "No outstanding request or newer outbound message was found." },
            recommendations,
            sources,
            incompleteContext,
            groundingLabel: "Based on GreenOS communication records",
        };
    }
}

export const communicationService = new CommunicationService();
