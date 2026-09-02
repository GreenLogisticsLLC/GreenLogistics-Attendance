import { prisma } from "../../../config/database.js";
import { LIFECYCLE_PIPELINE, type DomainEventType } from "../shipment.constants.js";
import { eventTypeForStatus, normalizeStatus, statusLabel } from "../shipment.lifecycle.js";
import { shipmentTimelineService } from "../../crm/services/timeline.service.js";

export type EmitDomainEventInput = {
    shipmentLeadId: string;
    eventType: DomainEventType;
    title?: string;
    message?: string;
    actorUserId?: string;
    payload?: Record<string, unknown>;
    /** Also project into ShipmentTimelineEvent (default true). */
    projectTimeline?: boolean;
    timelineStage?: string;
};

/**
 * Event Engine — every significant business action becomes a Domain Event.
 * Timeline is projected from these events (Rule 7 / Rule 8).
 */
export class DomainEventEngine {
    /**
     * Gmail events are card-specific only when the email was matched by a
     * listing/GOS identifier, or belongs to a thread that has such a match.
     * This excludes legacy title/city guesses that could leak between cards.
     */
    async trustedBrokerGmailMessageIds(shipmentLeadId: string): Promise<Set<string>> {
        const messages = await prisma.brokerMailboxMessage.findMany({
            where: { shipmentLeadId },
            select: {
                gmailMessageId: true,
                gmailThreadId: true,
                matchMethod: true,
            },
        });
        const strongMethods = new Set(["viewUrl", "externalShipmentId", "greenOsShipmentId"]);
        const trustedThreads = new Set(
            messages
                .filter((message) => strongMethods.has(String(message.matchMethod || "")))
                .map((message) => message.gmailThreadId)
                .filter((id): id is string => Boolean(id))
        );
        return new Set(
            messages
                .filter((message) => {
                    // Any message already linked to this card is trusted for Q&A lamps.
                    if (message.gmailMessageId) return true;
                    return (
                        strongMethods.has(String(message.matchMethod || "")) ||
                        (message.matchMethod === "gmailThreadId" &&
                            Boolean(
                                message.gmailThreadId &&
                                    trustedThreads.has(message.gmailThreadId)
                            ))
                    );
                })
                .map((message) => message.gmailMessageId)
                .filter((id): id is string => Boolean(id))
        );
    }

    artifactBelongsToShipment(
        json: string | null,
        trustedBrokerGmailMessageIds: Set<string>
    ): boolean {
        if (!json) return true;
        try {
            const payload = JSON.parse(json) as {
                source?: string;
                gmailMessageId?: string;
            };
            if (payload.source !== "broker_gmail") return true;
            return Boolean(
                payload.gmailMessageId &&
                    trustedBrokerGmailMessageIds.has(payload.gmailMessageId)
            );
        } catch {
            return true;
        }
    }

    async emit(input: EmitDomainEventInput) {
        const event = await prisma.domainEvent.create({
            data: {
                shipmentLeadId: input.shipmentLeadId,
                eventType: input.eventType,
                title: input.title || input.eventType.replace(/_/g, " "),
                message: input.message,
                actorUserId: input.actorUserId,
                payloadJson: input.payload ? JSON.stringify(input.payload) : undefined,
            },
        });

        if (input.projectTimeline !== false) {
            await shipmentTimelineService.addEvent({
                shipmentLeadId: input.shipmentLeadId,
                stage: input.timelineStage || input.eventType,
                title: input.title || input.eventType.replace(/_/g, " "),
                message: input.message,
                actorUserId: input.actorUserId,
                meta: {
                    domainEventId: event.eventId,
                    eventType: input.eventType,
                    ...(input.payload || {}),
                },
            });
        }

        return event;
    }

    listForShipment(shipmentLeadId: string) {
        return prisma.domainEvent.findMany({
            where: { shipmentLeadId },
            orderBy: { createdAt: "asc" },
        });
    }

    async emitStatusChange(input: {
        shipmentLeadId: string;
        fromStatus: string;
        toStatus: string;
        actorUserId?: string;
        message?: string;
        payload?: Record<string, unknown>;
    }) {
        const to = normalizeStatus(input.toStatus);
        const eventType = eventTypeForStatus(to);
        return this.emit({
            shipmentLeadId: input.shipmentLeadId,
            eventType,
            title: statusLabel(to),
            message:
                input.message ||
                `Status → ${statusLabel(to)}` +
                    (input.fromStatus ? ` (was ${statusLabel(input.fromStatus)})` : ""),
            actorUserId: input.actorUserId,
            payload: {
                fromStatus: input.fromStatus,
                toStatus: to,
                ...(input.payload || {}),
            },
            timelineStage: eventType,
        });
    }

    /** Pipeline stages for Shipment Card — derived from Domain Event types. */
    async buildLifecyclePipeline(shipmentLeadId: string) {
        const [rawEvents, rawTimeline, trustedMessageIds] = await Promise.all([
            prisma.domainEvent.findMany({
                where: { shipmentLeadId },
                select: { eventType: true, createdAt: true, payloadJson: true },
                orderBy: { createdAt: "asc" },
            }),
            prisma.shipmentTimelineEvent.findMany({
                where: { shipmentLeadId },
                select: { stage: true, createdAt: true, metaJson: true },
            }),
            this.trustedBrokerGmailMessageIds(shipmentLeadId),
        ]);
        const events = rawEvents.filter((event) =>
            this.artifactBelongsToShipment(event.payloadJson, trustedMessageIds)
        );
        const timeline = rawTimeline.filter((event) =>
            this.artifactBelongsToShipment(event.metaJson, trustedMessageIds)
        );
        const occurred = new Set(events.map((e) => e.eventType));
        for (const t of timeline) occurred.add(t.stage);

        const aliases: Record<string, string[]> = {
            CUSTOMER_RESPOND: ["CUSTOMER_RESPOND", "CUSTOMER_REPLIED", "CUSTOMER_QUESTION", "NEW_MESSAGE"],
            BROKER_QUESTION: ["BROKER_QUESTION"],
            BID_SUBMITTED: ["BID_SUBMITTED", "QUOTE_SENT"],
            CUSTOMER_ACCEPTED: ["CUSTOMER_ACCEPTED", "BOOKED", "ACCEPT_GREEN"],
            BROKER_ACCEPTED_WORK: ["BROKER_ACCEPTED_WORK", "BROKER_ACCEPTED", "AGENT_STARTED_WORK"],
            SHIPMENT_IMPORTED: ["SHIPMENT_IMPORTED", "IMPORTED"],
            BROKER_ASSIGNED: ["BROKER_ASSIGNED", "ASSIGNED"],
        };

        return LIFECYCLE_PIPELINE.map((step) => {
            const keys = aliases[step.stage] || [step.stage];
            const match = [...events]
                .reverse()
                .find((e) => keys.includes(e.eventType));
            const legacy = timeline
                .slice()
                .reverse()
                .find(
                    (t: { stage: string; createdAt: Date }) =>
                        keys.includes(t.stage) ||
                        (step.stage === "SHIPMENT_IMPORTED" && t.stage === "IMPORTED") ||
                        (step.stage === "BROKER_ASSIGNED" && t.stage === "ASSIGNED") ||
                        (step.stage === "BROKER_ACCEPTED_WORK" && t.stage === "BROKER_ACCEPTED") ||
                        (step.stage === "CUSTOMER_ACCEPTED" &&
                            (t.stage === "BOOKED" || t.stage === "ACCEPT_GREEN" || t.stage === "ACCEPTED")) ||
                        (step.stage === "BID_SUBMITTED" && t.stage === "QUOTE_SENT") ||
                        (step.stage === "CUSTOMER_RESPOND" &&
                            (t.stage === "CUSTOMER_REPLIED" || t.stage === "CUSTOMER_RESPOND"))
                );
            const done = Boolean(
                match || legacy || keys.some((k) => occurred.has(k))
            );
            // Load Created cannot light without Customer Accepted first.
            if (step.stage === "LOAD_CREATED") {
                const accepted =
                    occurred.has("CUSTOMER_ACCEPTED") ||
                    occurred.has("BOOKED") ||
                    occurred.has("ACCEPT_GREEN") ||
                    timeline.some(
                        (t: { stage: string }) =>
                            t.stage === "CUSTOMER_ACCEPTED" ||
                            t.stage === "ACCEPTED" ||
                            t.stage === "ACCEPT_GREEN" ||
                            t.stage === "BOOKED"
                    );
                if (!accepted) {
                    return {
                        stage: step.stage,
                        title: step.title,
                        status: step.status,
                        interactive: Boolean((step as { interactive?: boolean }).interactive),
                        done: false,
                        at: null,
                    };
                }
            }
            return {
                stage: step.stage,
                title: step.title,
                status: step.status,
                interactive: Boolean((step as { interactive?: boolean }).interactive),
                done,
                at: match?.createdAt || legacy?.createdAt || null,
            };
        });
    }

    /** Read-only Q&A for card display — no DB writes (fast). */
    async correspondenceForDisplay(shipmentLeadId: string) {
        const brokerTypes = ["BROKER_QUESTION", "BROKER_ANSWER"];
        const customerTypes = [
            "CUSTOMER_RESPOND",
            "CUSTOMER_REPLIED",
            "CUSTOMER_QUESTION",
            "NEW_MESSAGE",
        ];
        const [latestBroker, customerCandidates, trustedMessageIds] = await Promise.all([
            prisma.domainEvent.findFirst({
                where: { shipmentLeadId, eventType: { in: brokerTypes } },
                orderBy: { createdAt: "desc" },
            }),
            prisma.domainEvent.findMany({
                where: { shipmentLeadId, eventType: { in: customerTypes } },
                orderBy: { createdAt: "desc" },
                take: 30,
            }),
            this.trustedBrokerGmailMessageIds(shipmentLeadId),
        ]);
        const latestCustomer =
            customerCandidates.find((event) =>
                this.artifactBelongsToShipment(event.payloadJson, trustedMessageIds)
            ) || null;
        const out: Array<{
            id: string;
            kind: string;
            title: string;
            message: string | null;
            at: Date;
            actorUserId: string | null;
        }> = [];
        if (latestBroker) {
            out.push({
                id: latestBroker.eventId,
                kind: "BROKER_ANSWER",
                title: "Broker Answer",
                message: latestBroker.message || latestBroker.title,
                at: latestBroker.createdAt,
                actorUserId: latestBroker.actorUserId,
            });
        }
        if (latestCustomer) {
            out.push({
                id: latestCustomer.eventId,
                kind: "CUSTOMER_RESPOND",
                title: "Customer Respond",
                message: latestCustomer.message || latestCustomer.title,
                at: latestCustomer.createdAt,
                actorUserId: latestCustomer.actorUserId,
            });
        }
        out.sort((a, b) => a.at.getTime() - b.at.getTime());
        return out;
    }

    /**
     * Read-only Q&A view — never deletes history.
     * Display already keeps only the latest trusted Broker Answer / Customer Respond.
     */
    async listCorrespondence(shipmentLeadId: string) {
        return this.correspondenceForDisplay(shipmentLeadId);
    }

    /** @deprecated Prefer keeping history; display filters to the latest trusted items. */
    async pruneOlderQa(_shipmentLeadId: string, _side: "broker" | "customer", _keepEventId: string) {
        return;
    }
}

export const domainEventEngine = new DomainEventEngine();
