import { prisma } from "../../../config/database.js";
import {
    buildCarrierReviewSlots,
    CARRIER_PACKET_EXCLUDE_DOC_TYPES,
    carrierDocAiVerdict,
    isCarrierPacketExcluded,
    type CarrierReviewAiVerdict,
    type CarrierReviewDoc,
    type CarrierReviewSlot,
} from "../load-carrier-review.js";

/**
 * RC/BOL copies on the carrier profile must not appear on the next load.
 * They stay archived on the load that created them.
 */
export async function detachLoadDocsFromCarrierPacket(carrierId?: string | null) {
    await prisma.carrierDocument.updateMany({
        where: {
            ...(carrierId ? { carrierId } : {}),
            documentType: { in: [...CARRIER_PACKET_EXCLUDE_DOC_TYPES] },
            status: "CURRENT",
        },
        data: { status: "ARCHIVED" },
    });
}

async function latestAiByDocumentIds(
    documentIds: string[]
): Promise<Map<string, CarrierReviewAiVerdict>> {
    const out = new Map<string, CarrierReviewAiVerdict>();
    if (!documentIds.length) return out;
    const jobs = await prisma.aiDocumentJob.findMany({
        where: { documentId: { in: documentIds }, documentSource: "CARRIER" },
        orderBy: { createdAt: "desc" },
        include: { validation: true },
    });
    for (const job of jobs) {
        if (out.has(job.documentId)) continue;
        out.set(job.documentId, {
            jobId: job.jobId,
            status: job.status,
            trafficLight: job.validation?.trafficLight || null,
            overallStatus: job.validation?.overallStatus || null,
            classifiedDocType: job.classifiedDocType,
            verdict: carrierDocAiVerdict({
                status: job.status,
                trafficLight: job.validation?.trafficLight,
                overallStatus: job.validation?.overallStatus,
            }),
        });
    }
    return out;
}

/**
 * If a packet doc has never been queued for Document AI, enqueue once so Assign Carrier
 * can show Approved / Not Approved. Uses the load's broker (or carrier's assigned broker).
 */
async function enqueueMissingCarrierDocAi(input: {
    documentIds: string[];
    actorUserId?: string | null;
}) {
    const actorUserId = String(input.actorUserId || "").trim();
    if (!actorUserId || !input.documentIds.length) return;
    const existing = await prisma.aiDocumentJob.findMany({
        where: {
            documentId: { in: input.documentIds },
            documentSource: "CARRIER",
        },
        select: { documentId: true },
    });
    const have = new Set(existing.map((j) => j.documentId));
    const missing = input.documentIds.filter((id) => !have.has(id));
    if (!missing.length) return;
    try {
        const { documentAiJobService } = await import("../../ai/documents/job.service.js");
        for (const documentId of missing) {
            try {
                await documentAiJobService.enqueueCarrierUpload({
                    documentId,
                    actorUserId,
                });
            } catch (err) {
                console.warn(
                    `[doc-ai] assign-carrier backfill enqueue failed for ${documentId}`,
                    err instanceof Error ? err.message : err
                );
            }
        }
    } catch (err) {
        console.warn(
            "[doc-ai] assign-carrier backfill unavailable",
            err instanceof Error ? err.message : err
        );
    }
}

export async function buildLoadCarrierReviewPacket(input: {
    currentShipmentLeadId: string;
    carrierProfileId?: string | null;
    carrierMc?: string | null;
    packetDocs: CarrierReviewDoc[];
    /** Broker who owns the load — used to backfill Document AI jobs. */
    botActorUserId?: string | null;
}): Promise<CarrierReviewSlot[]> {
    await detachLoadDocsFromCarrierPacket();
    const packetDocs = (input.packetDocs || []).filter(
        (doc) => !isCarrierPacketExcluded(doc.documentType)
    );
    const slots = buildCarrierReviewSlots({ packetDocs });
    const docIds = slots
        .map((s) => s.document?.documentId)
        .filter((id): id is string => Boolean(id));

    await enqueueMissingCarrierDocAi({
        documentIds: docIds,
        actorUserId: input.botActorUserId,
    });

    const aiMap = await latestAiByDocumentIds(docIds);
    return slots.map((slot) => {
        const id = slot.document?.documentId;
        const ai = id ? aiMap.get(id) || null : null;
        return { ...slot, ai };
    });
}
