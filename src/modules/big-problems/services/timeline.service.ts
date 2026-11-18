import { prisma } from "../../../config/database.js";

export async function recordBpTimeline(input: {
    caseId: string;
    eventType: string;
    summary: string;
    actorUserId?: string | null;
    actorName?: string | null;
    details?: Record<string, unknown>;
}) {
    return prisma.bigProblemTimelineEvent.create({
        data: {
            caseId: input.caseId,
            eventType: input.eventType,
            summary: input.summary,
            actorUserId: input.actorUserId || undefined,
            actorName: input.actorName || undefined,
            detailsJson: input.details ? JSON.stringify(input.details) : undefined,
        },
    });
}

export async function listBpTimeline(caseId: string) {
    return prisma.bigProblemTimelineEvent.findMany({
        where: { caseId },
        orderBy: { createdAt: "desc" },
    });
}
