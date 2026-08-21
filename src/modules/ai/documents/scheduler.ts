import { prisma } from "../../../config/database.js";
import { processDocumentJob } from "./processor.js";

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

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
            const queued = await prisma.aiDocumentJob.findMany({
                where: { status: "QUEUED" },
                orderBy: { createdAt: "asc" },
                take: 3,
                select: { jobId: true },
            });
            for (const j of queued) {
                await processDocumentJob(j.jobId);
            }
            // Retry stuck PROCESSING older than 10 minutes
            const stale = await prisma.aiDocumentJob.findMany({
                where: {
                    status: "PROCESSING",
                    startedAt: { lt: new Date(Date.now() - 10 * 60_000) },
                    attempts: { lt: 3 },
                },
                take: 2,
                select: { jobId: true },
            });
            for (const j of stale) {
                await prisma.aiDocumentJob.update({
                    where: { jobId: j.jobId },
                    data: { status: "QUEUED" },
                });
            }
        } catch (err) {
            console.warn("[doc-ai] scheduler tick error:", err);
        } finally {
            running = false;
        }
    };
    timer = setInterval(() => {
        tick().catch(() => null);
    }, intervalMs);
    // warm start
    tick().catch(() => null);
    console.log(`[doc-ai] scheduler started (every ${intervalMs}ms)`);
}
