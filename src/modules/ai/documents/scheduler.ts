import { prisma } from "../../../config/database.js";
import { processDocumentJob } from "./processor.js";
import { runtimeLog } from "../../../utils/runtime-log.js";

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let didRequeueRedNoa = false;

function isPermanentPdfFailure(errorMessage: string | null | undefined): boolean {
    return /INVALID_PDF_STRUCTURE|invalid pdf structure|pdf header missing|missing %%EOF/i.test(
        String(errorMessage || "")
    );
}

/**
 * After extractor/OCR fixes, re-run CURRENT NOA docs that previously got RED
 * so carriers do not have to re-upload the same file.
 * Skip permanently malformed PDFs — they need manual re-upload, not infinite retries.
 */
async function requeueRedNoaOnce() {
    if (didRequeueBadNoaFlag()) return;
    didRequeueRedNoa = true;
    try {
        const currentNoa = await prisma.carrierDocument.findMany({
            where: { documentType: "NOA", status: "CURRENT" },
            orderBy: { uploadedAt: "desc" },
            take: 25,
            select: {
                documentId: true,
                carrierId: true,
                shipmentLeadId: true,
                checksum: true,
                documentType: true,
            },
        });
        let queued = 0;
        let skippedPermanent = 0;
        for (const doc of currentNoa) {
            const latest = await prisma.aiDocumentJob.findFirst({
                where: { documentId: doc.documentId, documentSource: "CARRIER" },
                orderBy: { createdAt: "desc" },
                include: { validation: true },
            });
            if (!latest?.validation || latest.validation.trafficLight !== "RED") continue;
            if (latest.status === "QUEUED" || latest.status === "PROCESSING") continue;
            if (isPermanentPdfFailure(latest.errorMessage)) {
                skippedPermanent += 1;
                continue;
            }
            const carrier = await prisma.carrier.findUnique({
                where: { carrierId: doc.carrierId },
                select: { assignedBrokerId: true },
            });
            const actorUserId = carrier?.assignedBrokerId || latest.actorUserId;
            if (!actorUserId) continue;
            await prisma.aiDocumentJob.create({
                data: {
                    documentSource: "CARRIER",
                    documentId: doc.documentId,
                    carrierId: doc.carrierId,
                    shipmentLeadId: doc.shipmentLeadId,
                    actorUserId,
                    checksum: doc.checksum || latest.checksum || "pending",
                    declaredDocType: doc.documentType,
                    status: "QUEUED",
                },
            });
            queued += 1;
        }
        if (queued) {
            runtimeLog("INFO", {
                module: "doc-ai",
                category: "RED_NOA_REQUEUE",
                message: `re-queued ${queued} RED NOA document(s) for re-check`,
                retryEligible: true,
            });
        }
        if (skippedPermanent) {
            runtimeLog("INFO", {
                module: "doc-ai",
                category: "INVALID_PDF_SKIP_REQUEUE",
                message: `skipped ${skippedPermanent} permanently invalid PDF NOA(s)`,
                retryEligible: false,
            });
        }
    } catch (err) {
        runtimeLog("WARNING", {
            module: "doc-ai",
            category: "RED_NOA_REQUEUE_FAILED",
            message: "RED NOA requeue failed",
            retryEligible: true,
            detail: err instanceof Error ? err.message : String(err),
        });
    }
}

function didRequeueBadNoaFlag() {
    return didRequeueRedNoa;
}

/**
 * Drain queued Document AI jobs using the same setInterval pattern as other GreenOS schedulers.
 * No Redis/Bull.
 */
export function startDocumentAiScheduler(intervalMs = 15_000) {
    if (timer) return;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await requeueRedNoaOnce();
            const queued = await prisma.aiDocumentJob.findMany({
                where: { status: "QUEUED" },
                orderBy: { createdAt: "asc" },
                take: 3,
                select: { jobId: true },
            });
            for (const j of queued) {
                await processDocumentJob(j.jobId);
            }
            // Retry stuck PROCESSING older than 10 minutes (never permanent PDF failures).
            const stale = await prisma.aiDocumentJob.findMany({
                where: {
                    status: "PROCESSING",
                    startedAt: { lt: new Date(Date.now() - 10 * 60_000) },
                    attempts: { lt: 3 },
                },
                take: 2,
                select: { jobId: true, errorMessage: true },
            });
            for (const j of stale) {
                if (isPermanentPdfFailure(j.errorMessage)) continue;
                await prisma.aiDocumentJob.update({
                    where: { jobId: j.jobId },
                    data: { status: "QUEUED" },
                });
            }
        } catch (err) {
            runtimeLog("WARNING", {
                module: "doc-ai",
                category: "SCHEDULER_TICK_ERROR",
                message: "scheduler tick error",
                retryEligible: true,
                detail: err instanceof Error ? err.message : String(err),
            });
        } finally {
            running = false;
        }
    };
    timer = setInterval(() => {
        tick().catch(() => null);
    }, intervalMs);
    // warm start
    tick().catch(() => null);
    runtimeLog("INFO", {
        module: "doc-ai",
        category: "SCHEDULER_STARTED",
        message: `scheduler started (every ${intervalMs}ms)`,
        retryEligible: false,
    });
}
