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

    /**
     * Q&A traffic-light: only the latest Broker Answer + latest Customer Respond.
     * Older duplicates are deleted from domain_events and linked timeline rows.
     */
    async listCorrespondence(shipmentLeadId: string) {
        const events = await this.listForShipment(shipmentLeadId);
        const qaTypes = new Set([
            "BROKER_QUESTION",
            "BROKER_ANSWER",
            "CUSTOMER_RESPOND",
            "CUSTOMER_REPLIED",
            "CUSTOMER_QUESTION",
            "NEW_MESSAGE",
        ]);

        const qa = events.filter((e: { eventType: string }) => qaTypes.has(e.eventType));
        let latestBroker: (typeof qa)[number] | null = null;
        let latestCustomer: (typeof qa)[number] | null = null;

        for (const e of qa) {
            const isBroker = e.eventType === "BROKER_QUESTION" || e.eventType === "BROKER_ANSWER";
            if (isBroker) {
                if (!latestBroker || e.createdAt >= latestBroker.createdAt) latestBroker = e;
            } else {
                if (!latestCustomer || e.createdAt >= latestCustomer.createdAt) latestCustomer = e;
            }
        }

        const keepIds = new Set(
            [latestBroker?.eventId, latestCustomer?.eventId].filter(Boolean) as string[]
        );
        const staleIds = qa
            .filter((e: { eventId: string }) => !keepIds.has(e.eventId))
            .map((e: { eventId: string }) => e.eventId);

        if (staleIds.length) {
            await prisma.domainEvent.deleteMany({ where: { eventId: { in: staleIds } } });
        }

        const timeline = await prisma.shipmentTimelineEvent.findMany({
            where: {
                shipmentLeadId,
                stage: {
                    in: [
                        "BROKER_QUESTION",
                        "BROKER_ANSWER",
                        "CUSTOMER_RESPOND",
                        "CUSTOMER_REPLIED",
                        "CUSTOMER_QUESTION",
                        "NEW_MESSAGE",
                    ],
                },
            },
            select: { eventId: true, metaJson: true, stage: true, createdAt: true },
            orderBy: { createdAt: "desc" },
        });

        const keepTimelineIds = new Set<string>();
        let keptBrokerTl = false;
        let keptCustomerTl = false;
        for (const t of timeline) {
            let domainEventId: string | null = null;
            try {
                domainEventId = t.metaJson ? JSON.parse(t.metaJson)?.domainEventId || null : null;
            } catch {
                domainEventId = null;
            }
            const isBroker = t.stage === "BROKER_QUESTION" || t.stage === "BROKER_ANSWER";
            if (domainEventId && keepIds.has(domainEventId)) {
                keepTimelineIds.add(t.eventId);
                if (isBroker) keptBrokerTl = true;
                else keptCustomerTl = true;
                continue;
            }
            if (!domainEventId) {
                if (isBroker && !keptBrokerTl) {
                    keepTimelineIds.add(t.eventId);
                    keptBrokerTl = true;
                } else if (!isBroker && !keptCustomerTl) {
                    keepTimelineIds.add(t.eventId);
                    keptCustomerTl = true;
                }
            }
        }
        const dropTl = timeline
            .map((t) => t.eventId)
            .filter((id) => !keepTimelineIds.has(id));
        if (dropTl.length) {
            await prisma.shipmentTimelineEvent.deleteMany({ where: { eventId: { in: dropTl } } });
        }

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

    /** Keep only the newest Q&A event of the given side (broker | customer). */
    async pruneOlderQa(shipmentLeadId: string, side: "broker" | "customer", keepEventId: string) {
        const brokerTypes = ["BROKER_QUESTION", "BROKER_ANSWER"];
        const customerTypes = [
            "CUSTOMER_RESPOND",
            "CUSTOMER_REPLIED",
            "CUSTOMER_QUESTION",
            "NEW_MESSAGE",
        ];
        const types = side === "broker" ? brokerTypes : customerTypes;
        await prisma.domainEvent.deleteMany({
            where: {
                shipmentLeadId,
                eventType: { in: types },
                eventId: { not: keepEventId },
            },
        });
    }
}

export const domainEventEngine = new DomainEventEngine();
