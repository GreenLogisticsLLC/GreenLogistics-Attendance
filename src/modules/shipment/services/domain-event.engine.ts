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

        return LIFECYCLE_PIPELINE.map((step) => {
            const match = events.find((e: { eventType: string; createdAt: Date }) => e.eventType === step.stage);
            const legacy = timeline.find(
                (t: { stage: string; createdAt: Date }) =>
                    t.stage === step.stage ||
                    (step.stage === "SHIPMENT_IMPORTED" && t.stage === "IMPORTED") ||
                    (step.stage === "BROKER_ASSIGNED" && t.stage === "ASSIGNED") ||
                    (step.stage === "BROKER_ACCEPTED_WORK" && t.stage === "BROKER_ACCEPTED") ||
                    (step.stage === "CUSTOMER_ACCEPTED" && t.stage === "BOOKED") ||
                    (step.stage === "BID_SUBMITTED" && t.stage === "QUOTE_SENT")
            );
            return {
                stage: step.stage,
                title: step.title,
                status: step.status,
                done: Boolean(match || legacy || occurred.has(step.stage)),
                at: match?.createdAt || legacy?.createdAt || null,
            };
        });
    }
}

export const domainEventEngine = new DomainEventEngine();
