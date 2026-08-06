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
        const events = await this.listForShipment(shipmentLeadId);
        const occurred = new Set(events.map((e: { eventType: string }) => e.eventType));
        // Also accept legacy timeline stages
        const timeline = await prisma.shipmentTimelineEvent.findMany({
            where: { shipmentLeadId },
            select: { stage: true, createdAt: true },
        });
        for (const t of timeline) occurred.add(t.stage);

        const aliases: Record<string, string[]> = {
            CUSTOMER_RESPOND: ["CUSTOMER_RESPOND", "CUSTOMER_REPLIED", "CUSTOMER_QUESTION", "NEW_MESSAGE"],
            BROKER_QUESTION: ["BROKER_QUESTION"],
            BID_SUBMITTED: ["BID_SUBMITTED", "QUOTE_SENT"],
            CUSTOMER_ACCEPTED: ["CUSTOMER_ACCEPTED", "BOOKED"],
            BROKER_ACCEPTED_WORK: ["BROKER_ACCEPTED_WORK", "BROKER_ACCEPTED", "AGENT_STARTED_WORK"],
            SHIPMENT_IMPORTED: ["SHIPMENT_IMPORTED", "IMPORTED"],
            BROKER_ASSIGNED: ["BROKER_ASSIGNED", "ASSIGNED"],
        };

        return LIFECYCLE_PIPELINE.map((step) => {
            const keys = aliases[step.stage] || [step.stage];
            const match = [...events]
                .reverse()
                .find((e: { eventType: string; createdAt: Date }) => keys.includes(e.eventType));
            const legacy = timeline
                .slice()
                .reverse()
                .find(
                    (t: { stage: string; createdAt: Date }) =>
                        keys.includes(t.stage) ||
                        (step.stage === "SHIPMENT_IMPORTED" && t.stage === "IMPORTED") ||
                        (step.stage === "BROKER_ASSIGNED" && t.stage === "ASSIGNED") ||
                        (step.stage === "BROKER_ACCEPTED_WORK" && t.stage === "BROKER_ACCEPTED") ||
                        (step.stage === "CUSTOMER_ACCEPTED" && t.stage === "BOOKED") ||
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
                    timeline.some(
                        (t: { stage: string }) =>
                            t.stage === "CUSTOMER_ACCEPTED" || t.stage === "ACCEPTED" || t.stage === "BOOKED"
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

    /** Q&A traffic-light history (every broker question / customer respond). */
    async listCorrespondence(shipmentLeadId: string) {
        const events = await this.listForShipment(shipmentLeadId);
        return events
            .filter((e: { eventType: string }) =>
                [
                    "BROKER_QUESTION",
                    "CUSTOMER_RESPOND",
                    "CUSTOMER_REPLIED",
                    "CUSTOMER_QUESTION",
                    "NEW_MESSAGE",
                ].includes(e.eventType)
            )
            .map((e: { eventId: string; eventType: string; title: string | null; message: string | null; createdAt: Date; actorUserId: string | null }) => ({
                id: e.eventId,
                kind:
                    e.eventType === "BROKER_QUESTION"
                        ? "BROKER_QUESTION"
                        : "CUSTOMER_RESPOND",
                title:
                    e.eventType === "BROKER_QUESTION"
                        ? "Broker Question"
                        : "Customer Respond",
                message: e.message || e.title,
                at: e.createdAt,
                actorUserId: e.actorUserId,
            }));
    }
}

export const domainEventEngine = new DomainEventEngine();
