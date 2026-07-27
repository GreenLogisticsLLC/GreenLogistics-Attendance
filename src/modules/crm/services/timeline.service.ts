import { prisma } from "../../../config/database.js";
import { TIMELINE_STAGES, type TimelineStage } from "../crm.constants.js";

export class ShipmentTimelineService {
    async addEvent(input: {
        shipmentLeadId: string;
        stage: TimelineStage | string;
        title?: string;
        message?: string;
        actorUserId?: string;
        meta?: Record<string, unknown>;
    }) {
        const known = TIMELINE_STAGES.find((s: (typeof TIMELINE_STAGES)[number]) => s.stage === input.stage);
        return prisma.shipmentTimelineEvent.create({
            data: {
                shipmentLeadId: input.shipmentLeadId,
                stage: input.stage,
                title: input.title || known?.title || input.stage,
                message: input.message,
                actorUserId: input.actorUserId,
                metaJson: input.meta ? JSON.stringify(input.meta) : undefined,
            },
        });
    }

    listForShipment(shipmentLeadId: string) {
        return prisma.shipmentTimelineEvent.findMany({
            where: { shipmentLeadId },
            orderBy: { createdAt: "asc" },
        });
    }
}

export const shipmentTimelineService = new ShipmentTimelineService();
