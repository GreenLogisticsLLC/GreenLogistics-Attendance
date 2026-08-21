import { prisma } from "../../../config/database.js";
import { carrierService } from "../../carriers/services/carrier.service.js";
import { assertShipmentAccessOrThrow } from "../../../auth/access.js";
import { processDocumentJob } from "./processor.js";

export type DocAiActor = { userId: string; role: string };

export class DocumentAiJobService {
    async enqueue(input: {
        actor: DocAiActor;
        documentSource: "CARRIER" | "LOAD";
        documentId: string;
    }) {
        const documentId = String(input.documentId || "").trim();
        if (!documentId) {
            throw Object.assign(new Error("documentId is required"), { status: 422 });
        }

        let carrierId: string | null = null;
        let shipmentLeadId: string | null = null;
        let declaredDocType: string | null = null;
        let checksum = "pending";

        if (input.documentSource === "CARRIER") {
            const doc = await prisma.carrierDocument.findUnique({ where: { documentId } });
            if (!doc) throw Object.assign(new Error("Carrier document not found"), { status: 404 });
            await carrierService.assertCarrierAccess(doc.carrierId, input.actor);
            carrierId = doc.carrierId;
            shipmentLeadId = doc.shipmentLeadId;
            declaredDocType = doc.documentType;
            checksum = doc.checksum || "pending";
        } else {
            const doc = await prisma.loadDocument.findUnique({ where: { documentId } });
            if (!doc) throw Object.assign(new Error("Load document not found"), { status: 404 });
            await assertShipmentAccessOrThrow(input.actor, doc.shipmentLeadId);
            shipmentLeadId = doc.shipmentLeadId;
            declaredDocType = doc.docType;
            const lead = await prisma.shipmentLead.findUnique({
                where: { shipmentLeadId: doc.shipmentLeadId },
                select: { carrierProfileId: true },
            });
            carrierId = lead?.carrierProfileId || null;
        }

        const job = await prisma.aiDocumentJob.create({
            data: {
                documentSource: input.documentSource,
                documentId,
                carrierId,
                shipmentLeadId,
                actorUserId: input.actor.userId,
                checksum,
                declaredDocType,
                status: "QUEUED",
            },
        });

        // Non-blocking kick — scheduler also drains queue
        setImmediate(() => {
            processDocumentJob(job.jobId).catch((err) =>
                console.warn("[doc-ai] immediate process failed", err)
            );
        });

        return { jobId: job.jobId, status: job.status };
    }

    async getJob(actor: DocAiActor, jobId: string) {
        const job = await prisma.aiDocumentJob.findUnique({
            where: { jobId },
            include: {
                extraction: { include: { fields: true } },
                validation: true,
            },
        });
        if (!job) throw Object.assign(new Error("Job not found"), { status: 404 });
        await this.assertJobAccess(actor, job);
        return this.serializeJob(job);
    }

    async getLatestForDocument(actor: DocAiActor, documentId: string) {
        const job = await prisma.aiDocumentJob.findFirst({
            where: { documentId },
            orderBy: { createdAt: "desc" },
            include: {
                extraction: { include: { fields: true } },
                validation: true,
            },
        });
        if (!job) return null;
        await this.assertJobAccess(actor, job);
        return this.serializeJob(job);
    }

    async submitReview(
        actor: DocAiActor,
        jobId: string,
        input: { decision: string; notes?: string }
    ) {
        const job = await prisma.aiDocumentJob.findUnique({
            where: { jobId },
            include: { validation: true },
        });
        if (!job?.validation) throw Object.assign(new Error("Validation not found"), { status: 404 });
        await this.assertJobAccess(actor, job);
        const decision = String(input.decision || "").toUpperCase();
        if (!["ACCEPT", "REJECT", "REQUEST_CHANGES"].includes(decision)) {
            throw Object.assign(new Error("decision must be ACCEPT | REJECT | REQUEST_CHANGES"), {
                status: 422,
            });
        }
        // Never mutate Carrier/ShipmentLead master data here.
        const updated = await prisma.documentValidationResult.update({
            where: { jobId },
            data: {
                reviewerUserId: actor.userId,
                reviewedAt: new Date(),
                reviewDecision: decision,
                reviewNotes: input.notes ? String(input.notes).slice(0, 2000) : null,
                requiresReview: decision === "REQUEST_CHANGES",
            },
        });
        return updated;
    }

    private async assertJobAccess(
        actor: DocAiActor,
        job: { carrierId: string | null; shipmentLeadId: string | null; documentSource: string }
    ) {
        if (job.carrierId) {
            await carrierService.assertCarrierAccess(job.carrierId, actor);
        }
        if (job.shipmentLeadId) {
            await assertShipmentAccessOrThrow(actor, job.shipmentLeadId);
        }
    }

    private serializeJob(job: {
        jobId: string;
        documentSource: string;
        documentId: string;
        carrierId: string | null;
        shipmentLeadId: string | null;
        checksum: string;
        declaredDocType: string | null;
        classifiedDocType: string | null;
        status: string;
        attempts: number;
        errorMessage: string | null;
        providerModel: string | null;
        cachedFromJobId: string | null;
        createdAt: Date;
        startedAt: Date | null;
        completedAt: Date | null;
        extraction: {
            extractionId: string;
            documentType: string;
            pageCount: number | null;
            textCharCount: number | null;
            overallConfidence: number | null;
            signaturesJson: string | null;
            metaJson: string | null;
            fields: Array<{
                fieldKey: string;
                valueText: string | null;
                valueNormalized: string | null;
                confidence: number | null;
                page: number | null;
                source: string | null;
                method: string | null;
                fieldStatus: string;
            }>;
        } | null;
        validation: {
            validationId: string;
            overallStatus: string;
            trafficLight: string;
            levelsJson: string | null;
            checksJson: string | null;
            matchesJson: string | null;
            warningsJson: string | null;
            errorsJson: string | null;
            requiresReview: boolean;
            reviewerUserId: string | null;
            reviewedAt: Date | null;
            reviewDecision: string | null;
            reviewNotes: string | null;
        } | null;
    }) {
        return {
            jobId: job.jobId,
            documentSource: job.documentSource,
            documentId: job.documentId,
            carrierId: job.carrierId,
            shipmentLeadId: job.shipmentLeadId,
            checksum: job.checksum,
            declaredDocType: job.declaredDocType,
            classifiedDocType: job.classifiedDocType,
            status: job.status,
            attempts: job.attempts,
            errorMessage: job.errorMessage,
            providerModel: job.providerModel,
            cachedFromJobId: job.cachedFromJobId,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            extraction: job.extraction
                ? {
                      extractionId: job.extraction.extractionId,
                      documentType: job.extraction.documentType,
                      pageCount: job.extraction.pageCount,
                      textCharCount: job.extraction.textCharCount,
                      overallConfidence: job.extraction.overallConfidence,
                      signatures: safeJson(job.extraction.signaturesJson),
                      meta: safeJson(job.extraction.metaJson),
                      fields: job.extraction.fields,
                  }
                : null,
            validation: job.validation
                ? {
                      validationId: job.validation.validationId,
                      overallStatus: job.validation.overallStatus,
                      trafficLight: job.validation.trafficLight,
                      levels: safeJson(job.validation.levelsJson),
                      checks: safeJson(job.validation.checksJson),
                      matches: safeJson(job.validation.matchesJson),
                      warnings: safeJson(job.validation.warningsJson),
                      errors: safeJson(job.validation.errorsJson),
                      requiresReview: job.validation.requiresReview,
                      reviewerUserId: job.validation.reviewerUserId,
                      reviewedAt: job.validation.reviewedAt,
                      reviewDecision: job.validation.reviewDecision,
                      reviewNotes: job.validation.reviewNotes,
                  }
                : null,
        };
    }
}

function safeJson(raw: string | null) {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export const documentAiJobService = new DocumentAiJobService();
