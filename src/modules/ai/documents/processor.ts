import crypto from "crypto";
import fs from "fs";
import path from "path";
import { prisma } from "../../../config/database.js";
import { carrierStorageService } from "../../carriers/services/carrier-storage.service.js";
import { LOAD_DOCS_ROOT } from "../../shipment/services/load-pdf.service.js";
import { classifyDocumentText, type DocAiType } from "./classify.js";
import { extractFieldsForType } from "./extract.js";
import { extractDocumentText } from "./text-extract.js";
import { analyzeSignaturesFromText, type SignatureResult } from "./signature.js";
import { validateDocument } from "./validate.js";
import { aiGateway } from "../services/ai-gateway.js";

export type ProcessJobResult = {
    jobId: string;
    status: string;
    overallStatus?: string;
    trafficLight?: string;
    classifiedDocType?: string;
};

function sha256File(abs: string): string {
    const buf = fs.readFileSync(abs);
    return crypto.createHash("sha256").update(buf).digest("hex");
}

function pathJoinSafe(root: string, id: string, name: string): string {
    const resolved = path.resolve(path.join(root, id, name));
    const base = path.resolve(path.join(root, id));
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
        throw Object.assign(new Error("Invalid document path"), { status: 400 });
    }
    return resolved;
}

async function resolveFilePath(job: {
    documentSource: string;
    documentId: string;
    carrierId: string | null;
}): Promise<{
    absPath: string;
    declaredType: string | null;
    fileName: string | null;
    carrierId: string | null;
    shipmentLeadId: string | null;
} | null> {
    if (job.documentSource === "CARRIER") {
        const doc = await prisma.carrierDocument.findUnique({ where: { documentId: job.documentId } });
        if (!doc) return null;
        const abs = carrierStorageService.absolutePath(doc.carrierId, doc.storageKey);
        return {
            absPath: abs,
            declaredType: doc.documentType,
            fileName: doc.originalFilename,
            carrierId: doc.carrierId,
            shipmentLeadId: doc.shipmentLeadId,
        };
    }
    const doc = await prisma.loadDocument.findUnique({ where: { documentId: job.documentId } });
    if (!doc || !doc.storedName) return null;
    const abs = pathJoinSafe(LOAD_DOCS_ROOT, doc.shipmentLeadId, doc.storedName);
    return {
        absPath: abs,
        declaredType: doc.docType,
        fileName: doc.fileName,
        carrierId: null,
        shipmentLeadId: doc.shipmentLeadId,
    };
}

async function loadGreenOsContext(input: {
    carrierId: string | null;
    shipmentLeadId: string | null;
}) {
    const out: {
        legalName?: string | null;
        mcNumber?: string | null;
        dotNumber?: string | null;
        loadNumber?: string | null;
        carrierName?: string | null;
        carrierMc?: string | null;
        carrierDot?: string | null;
    } = {};
    if (input.carrierId) {
        const c = await prisma.carrier.findUnique({
            where: { carrierId: input.carrierId },
            select: { legalName: true, mcNumber: true, dotNumber: true },
        });
        if (c) {
            out.legalName = c.legalName;
            out.mcNumber = c.mcNumber;
            out.dotNumber = c.dotNumber;
        }
    }
    if (input.shipmentLeadId) {
        const s = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: input.shipmentLeadId },
            select: {
                loadNumber: true,
                carrierName: true,
                carrierMc: true,
                carrierDot: true,
                carrierProfileId: true,
            },
        });
        if (s) {
            out.loadNumber = s.loadNumber;
            out.carrierName = s.carrierName;
            out.carrierMc = s.carrierMc;
            out.carrierDot = s.carrierDot;
            if (s.carrierProfileId && !input.carrierId) {
                const c = await prisma.carrier.findUnique({
                    where: { carrierId: s.carrierProfileId },
                    select: { legalName: true, mcNumber: true, dotNumber: true },
                });
                if (c) {
                    out.legalName = c.legalName;
                    out.mcNumber = c.mcNumber || out.carrierMc;
                    out.dotNumber = c.dotNumber || out.carrierDot;
                }
            }
        }
    }
    return out;
}

export async function processDocumentJob(jobId: string): Promise<ProcessJobResult> {
    const job = await prisma.aiDocumentJob.findUnique({ where: { jobId } });
    if (!job) throw Object.assign(new Error("Job not found"), { status: 404 });
    if (job.status === "SUCCEEDED" || job.status === "CACHED") {
        return { jobId, status: job.status, classifiedDocType: job.classifiedDocType || undefined };
    }

    await prisma.aiDocumentJob.update({
        where: { jobId },
        data: {
            status: "PROCESSING",
            attempts: { increment: 1 },
            startedAt: new Date(),
            errorMessage: null,
        },
    });

    try {
        const file = await resolveFilePath(job);
        if (!file) {
            throw Object.assign(new Error("Document file not found"), { status: 404 });
        }
        if (!fs.existsSync(file.absPath)) {
            throw Object.assign(new Error("Document file missing on disk"), { status: 404 });
        }

        const checksum = sha256File(file.absPath);

        // Checksum cache — reuse prior successful job for same document+checksum
        const prior = await prisma.aiDocumentJob.findFirst({
            where: {
                documentId: job.documentId,
                checksum,
                status: { in: ["SUCCEEDED", "CACHED"] },
                jobId: { not: jobId },
                validation: { isNot: null },
            },
            orderBy: { completedAt: "desc" },
            include: { validation: true, extraction: { include: { fields: true } } },
        });
        if (prior?.validation && prior.extraction) {
            await cloneCachedResult(jobId, prior);
            return {
                jobId,
                status: "CACHED",
                overallStatus: prior.validation.overallStatus,
                trafficLight: prior.validation.trafficLight,
                classifiedDocType: prior.classifiedDocType || undefined,
            };
        }

        const textResult = await extractDocumentText(file.absPath);
        const classified = classifyDocumentText({
            text: textResult.text,
            declaredType: file.declaredType || job.declaredDocType,
            fileName: file.fileName,
        });

        let signatures: SignatureResult[] = analyzeSignaturesFromText({
            text: textResult.text,
            documentType: classified.documentType,
        });

        // Vision only when text inadequate or signature uncertain for critical types
        const needsVision =
            !textResult.adequate ||
            (["POD", "W9", "BOL"].includes(classified.documentType) &&
                signatures.some((s) => s.status === "UNCERTAIN" || s.status === "MISSING"));
        if (needsVision && aiGateway.isConfigured() && process.env.DOC_AI_VISION === "true") {
            // Optional — default off to control cost; heuristics + REVIEW cover Phase 2B safety.
            try {
                signatures = signatures.map((s) =>
                    s.status === "UNCERTAIN"
                        ? { ...s, reason: s.reason + " (vision deferred/cost-controlled)" }
                        : s
                );
            } catch {
                /* keep heuristic signatures */
            }
        }

        const fields = extractFieldsForType(classified.documentType as DocAiType, textResult.text);
        const greenOs = await loadGreenOsContext({
            carrierId: file.carrierId || job.carrierId,
            shipmentLeadId: file.shipmentLeadId || job.shipmentLeadId,
        });
        const validation = validateDocument({
            documentType: classified.documentType,
            classifyConfidence: classified.confidence,
            requiresBoundaryReview: classified.requiresBoundaryReview || !textResult.adequate,
            fields,
            signatures,
            greenOs,
        });

        const extraction = await prisma.aiDocumentExtraction.create({
            data: {
                jobId,
                documentType: classified.documentType,
                pageCount: textResult.pageCount,
                textCharCount: textResult.text.length,
                overallConfidence: validation.confidence,
                signaturesJson: JSON.stringify(signatures),
                metaJson: JSON.stringify({
                    classifyReasons: classified.reasons,
                    textMethod: textResult.method,
                    textAdequate: textResult.adequate,
                }),
                fields: {
                    create: fields.map((f) => ({
                        fieldKey: f.fieldKey,
                        valueText: f.valueText,
                        valueNormalized: f.valueNormalized,
                        valueProtected: f.valueProtected || null,
                        confidence: f.confidence,
                        page: f.page,
                        source: f.source,
                        method: f.method,
                        fieldStatus: f.fieldStatus,
                    })),
                },
            },
        });

        await prisma.documentValidationResult.create({
            data: {
                jobId,
                overallStatus: validation.overallStatus,
                trafficLight: validation.trafficLight,
                levelsJson: JSON.stringify(validation.levels),
                checksJson: JSON.stringify(validation.checks),
                matchesJson: JSON.stringify(validation.matches),
                warningsJson: JSON.stringify(validation.warnings),
                errorsJson: JSON.stringify(validation.errors),
                requiresReview: validation.requiresReview,
            },
        });

        await prisma.aiDocumentJob.update({
            where: { jobId },
            data: {
                status: "SUCCEEDED",
                checksum,
                declaredDocType: file.declaredType || job.declaredDocType,
                classifiedDocType: classified.documentType,
                carrierId: file.carrierId || job.carrierId,
                shipmentLeadId: file.shipmentLeadId || job.shipmentLeadId,
                providerModel: aiGateway.getModel(),
                completedAt: new Date(),
                errorMessage: null,
            },
        });

        void extraction;
        return {
            jobId,
            status: "SUCCEEDED",
            overallStatus: validation.overallStatus,
            trafficLight: validation.trafficLight,
            classifiedDocType: classified.documentType,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Document AI processing failed";
        console.warn(`[doc-ai] job ${jobId} failed:`, msg);
        await prisma.aiDocumentJob
            .update({
                where: { jobId },
                data: {
                    status: "FAILED",
                    errorMessage: msg.slice(0, 1000),
                    completedAt: new Date(),
                },
            })
            .catch(() => null);
        return { jobId, status: "FAILED" };
    }
}

async function cloneCachedResult(
    jobId: string,
    prior: {
        jobId: string;
        classifiedDocType: string | null;
        checksum: string;
        extraction: {
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
                valueProtected: string | null;
                confidence: number | null;
                page: number | null;
                source: string | null;
                method: string | null;
                fieldStatus: string;
            }>;
        } | null;
        validation: {
            overallStatus: string;
            trafficLight: string;
            levelsJson: string | null;
            checksJson: string | null;
            matchesJson: string | null;
            warningsJson: string | null;
            errorsJson: string | null;
            requiresReview: boolean;
        } | null;
    }
) {
    if (!prior.extraction || !prior.validation) return;
    await prisma.aiDocumentExtraction.create({
        data: {
            jobId,
            documentType: prior.extraction.documentType,
            pageCount: prior.extraction.pageCount,
            textCharCount: prior.extraction.textCharCount,
            overallConfidence: prior.extraction.overallConfidence,
            signaturesJson: prior.extraction.signaturesJson,
            metaJson: JSON.stringify({ cachedFromJobId: prior.jobId }),
            fields: {
                create: prior.extraction.fields.map((f) => ({
                    fieldKey: f.fieldKey,
                    valueText: f.valueText,
                    valueNormalized: f.valueNormalized,
                    valueProtected: f.valueProtected,
                    confidence: f.confidence,
                    page: f.page,
                    source: f.source,
                    method: f.method,
                    fieldStatus: f.fieldStatus,
                })),
            },
        },
    });
    await prisma.documentValidationResult.create({
        data: {
            jobId,
            overallStatus: prior.validation.overallStatus,
            trafficLight: prior.validation.trafficLight,
            levelsJson: prior.validation.levelsJson,
            checksJson: prior.validation.checksJson,
            matchesJson: prior.validation.matchesJson,
            warningsJson: prior.validation.warningsJson,
            errorsJson: prior.validation.errorsJson,
            requiresReview: prior.validation.requiresReview,
        },
    });
    await prisma.aiDocumentJob.update({
        where: { jobId },
        data: {
            status: "CACHED",
            checksum: prior.checksum,
            classifiedDocType: prior.classifiedDocType,
            cachedFromJobId: prior.jobId,
            completedAt: new Date(),
        },
    });
}
