import crypto from "crypto";
import fs from "fs";
import path from "path";
import { prisma } from "../../../config/database.js";
import { carrierStorageService } from "../../carriers/services/carrier-storage.service.js";
import { resolveLoadDocumentAbsolutePath } from "../../shipment/services/load-pdf.service.js";
import { classifyDocumentText, type DocAiType } from "./classify.js";
import { extractFieldsForType, type ExtractedField } from "./extract.js";
import type { W9Marks } from "./w9-marks.js";
import type { McCertificate } from "./mc-certificate.js";
import { extractDocumentText } from "./text-extract.js";
import { assertValidPdfOrThrow } from "./pdf-validate.js";
import { analyzeSignaturesFromText, analyzeSignatureWithVision, type SignatureResult } from "./signature.js";
import { validateDocument } from "./validate.js";
import { aiGateway } from "../services/ai-gateway.js";
import { isPermanentInvalidPdfError, runtimeLog } from "../../../utils/runtime-log.js";

export type ProcessJobResult = {
    jobId: string;
    status: string;
    overallStatus?: string;
    trafficLight?: string;
    classifiedDocType?: string;
};

function mergeMcCertificate(fields: ExtractedField[], cert: McCertificate): ExtractedField[] {
    const set = (key: string, value: string | null) => {
        if (!value) return;
        const next: ExtractedField = {
            fieldKey: key,
            valueText: value,
            valueNormalized: value,
            confidence: 0.97,
            page: 1,
            source: "mc-certificate",
            method: "layout",
            fieldStatus: "FIELD_FOUND",
        };
        const idx = fields.findIndex((field) => field.fieldKey === key);
        if (idx >= 0) fields[idx] = next;
        else fields.push(next);
    };
    set("mcNumber", cert.mc);
    set("dotNumber", cert.dot);
    set("legalName", cert.name);
    return fields;
}

function mergeW9Marks(fields: ExtractedField[], marks: W9Marks): ExtractedField[] {
    const set = (key: string, value: string | null, extra: Partial<ExtractedField> = {}) => {
        const next: ExtractedField = {
            fieldKey: key,
            valueText: value,
            valueNormalized: value,
            confidence: value ? 0.94 : 0,
            page: 1,
            source: "w9-layout",
            method: "layout",
            fieldStatus: value ? "FIELD_FOUND" : "FIELD_MISSING",
            ...extra,
        };
        const idx = fields.findIndex((field) => field.fieldKey === key);
        if (idx >= 0) {
            if (value) fields[idx] = { ...fields[idx], ...next };
        } else if (value) {
            fields.push(next);
        }
    };
    if (marks.name) set("name", marks.name);
    if (marks.ein) {
        const redacted = `******${marks.ein.replace(/\D/g, "").slice(-4)}`;
        set("ein", redacted, { fieldStatus: "FIELD_FOUND", confidence: 0.96 });
        set("tinType", "EIN");
    }
    if (marks.signed) set("signaturePresent", "yes");
    if (marks.signatureDate) set("signatureDate", marks.signatureDate);
    return fields;
}

function sha256File(abs: string): string {
    const buf = fs.readFileSync(abs);
    return crypto.createHash("sha256").update(buf).digest("hex");
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
    const abs = resolveLoadDocumentAbsolutePath(doc.shipmentLeadId, doc.storedName);
    if (!abs) return null;
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
        address?: string | null;
        city?: string | null;
        state?: string | null;
        zip?: string | null;
    } = {};
    if (input.carrierId) {
        const c = await prisma.carrier.findUnique({
            where: { carrierId: input.carrierId },
            select: {
                legalName: true,
                mcNumber: true,
                dotNumber: true,
                address: true,
                city: true,
                state: true,
                zip: true,
            },
        });
        if (c) {
            out.legalName = c.legalName;
            out.mcNumber = c.mcNumber;
            out.dotNumber = c.dotNumber;
            out.address = c.address;
            out.city = c.city;
            out.state = c.state;
            out.zip = c.zip;
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
                    select: {
                        legalName: true,
                        mcNumber: true,
                        dotNumber: true,
                        address: true,
                        city: true,
                        state: true,
                        zip: true,
                    },
                });
                if (c) {
                    out.legalName = c.legalName;
                    out.mcNumber = c.mcNumber || out.carrierMc;
                    out.dotNumber = c.dotNumber || out.carrierDot;
                    out.address = c.address;
                    out.city = c.city;
                    out.state = c.state;
                    out.zip = c.zip;
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

        // Checksum cache — reuse prior SUCCESSFUL (GREEN) job only. Never reuse RED/YELLOW
        // so re-uploads after extractor fixes are re-evaluated.
        const prior = await prisma.aiDocumentJob.findFirst({
            where: {
                documentId: job.documentId,
                checksum,
                status: { in: ["SUCCEEDED", "CACHED"] },
                jobId: { not: jobId },
                validation: { trafficLight: "GREEN" },
            },
            orderBy: { completedAt: "desc" },
            include: { validation: true, extraction: { include: { fields: true } } },
        });
        if (prior?.validation && prior.extraction && prior.validation.trafficLight === "GREEN") {
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
        const declaredType = file.declaredType || job.declaredDocType || null;
        const classified = classifyDocumentText({
            text: textResult.text,
            declaredType,
            fileName: file.fileName,
        });

        // Prefer the carrier-declared packet type for NOA/W9 (user-scoped checks).
        const documentType: DocAiType =
            declaredType === "NOA" ||
            declaredType === "W9" ||
            declaredType === "BROKER_CARRIER_AGREEMENT" ||
            declaredType === "MC_AUTHORITY"
                ? (declaredType as DocAiType)
                : (classified.documentType as DocAiType);

        let fields = extractFieldsForType(documentType, textResult.text);
        if (documentType === "MC_AUTHORITY" && file.absPath) {
            try {
                const { readMcCertificate } = await import("./mc-certificate.js");
                const cert = await readMcCertificate(file.absPath);
                fields = mergeMcCertificate(fields, cert);
            } catch (err) {
                console.warn("[doc-ai] MC certificate read failed:", err instanceof Error ? err.message : err);
            }
        }
        if (documentType === "W9" && file.absPath) {
            try {
                const { readW9CircledMarks } = await import("./w9-marks.js");
                const marks = await readW9CircledMarks(file.absPath);
                fields = mergeW9Marks(fields, marks);
            } catch (err) {
                console.warn("[doc-ai] W-9 circled marks failed:", err instanceof Error ? err.message : err);
            }
        }
        let signatures: SignatureResult[] = analyzeSignaturesFromText({
            text: textResult.text,
            documentType,
        });

        // Scanned NOA: if title still missing after OCR, use OpenAI vision on the page image.
        const noaTitleMissing =
            documentType === "NOA" &&
            !fields.some((f) => f.fieldKey === "documentTitle" && f.valueText);
        if (noaTitleMissing && aiGateway.isConfigured()) {
            try {
                if (path.extname(file.absPath).toLowerCase() === ".pdf") {
                    assertValidPdfOrThrow(file.absPath);
                }
                const { renderPdfFirstEmbeddedImagePng } = await import("./pdf-enrich.js");
                const { extractNoaFieldsWithVision } = await import("./vision-extract.js");
                const png = await renderPdfFirstEmbeddedImagePng(file.absPath);
                if (png) {
                    const visionFields = await extractNoaFieldsWithVision({
                        imageBase64: png.toString("base64"),
                        mimeType: "image/png",
                    });
                    if (visionFields.some((f) => f.fieldKey === "documentTitle" && f.valueText)) {
                        fields = visionFields;
                    }
                }
            } catch (err) {
                if (isPermanentInvalidPdfError(err)) {
                    throw Object.assign(
                        new Error(err instanceof Error ? err.message : "Invalid PDF structure"),
                        { code: "INVALID_PDF_STRUCTURE", permanent: true, status: 422 }
                    );
                }
                runtimeLog("WARNING", {
                    module: "doc-ai",
                    category: "NOA_VISION_FALLBACK_FAILED",
                    message: "NOA vision fallback failed",
                    shipmentId: file.shipmentLeadId,
                    retryEligible: true,
                    detail: err instanceof Error ? err.message : String(err),
                });
            }
        }

        // Vision when enabled — inspect image pages for signatures (never OCR-name alone).
        const needsVision =
            !textResult.adequate ||
            (["POD", "W9", "BOL", "NOA"].includes(documentType) &&
                signatures.some((s) => s.status === "UNCERTAIN" || s.status === "MISSING"));
        if (needsVision && aiGateway.isConfigured() && process.env.DOC_AI_VISION === "true") {
            try {
                const ext = path.extname(file.absPath).toLowerCase();
                if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) {
                    const buf = fs.readFileSync(file.absPath);
                    const b64 = buf.toString("base64");
                    const mime =
                        ext === ".png"
                            ? "image/png"
                            : ext === ".webp"
                              ? "image/webp"
                              : ext === ".gif"
                                ? "image/gif"
                                : "image/jpeg";
                    if (documentType === "W9" && !textResult.adequate) {
                        const { extractW9FieldsWithVision } = await import("./vision-extract.js");
                        const visionFields = await extractW9FieldsWithVision({
                            imageBase64: b64,
                            mimeType: mime,
                        });
                        if (visionFields.length) fields = visionFields;
                    }
                    const role = signatures[0]?.role || (documentType === "W9" ? "TAXPAYER" : "RECEIVER");
                    const visionSig = await analyzeSignatureWithVision({
                        role,
                        imageBase64: b64,
                        mimeType: mime,
                        page: 1,
                    });
                    signatures = [visionSig, ...signatures.filter((s) => s.role !== role)];
                } else {
                    // PDF without rasterization: keep heuristic UNCERTAIN → REVIEW (safe).
                    signatures = signatures.map((s) =>
                        s.status === "UNCERTAIN" || s.method === "heuristic"
                            ? {
                                  ...s,
                                  reason:
                                      s.reason +
                                      " (DOC_AI_VISION on, but PDF page rasterization not available — REVIEW)",
                              }
                            : s
                    );
                }
            } catch (err) {
                console.warn(
                    "[doc-ai] vision signature failed:",
                    err instanceof Error ? err.message : err
                );
            }
        }
        const greenOs = await loadGreenOsContext({
            carrierId: file.carrierId || job.carrierId,
            shipmentLeadId: file.shipmentLeadId || job.shipmentLeadId,
        });
        const validation = validateDocument({
            documentType,
            classifyConfidence: classified.confidence,
            requiresBoundaryReview: classified.requiresBoundaryReview || !textResult.adequate,
            fields,
            signatures,
            greenOs,
        });

        const extraction = await prisma.aiDocumentExtraction.create({
            data: {
                jobId,
                documentType,
                pageCount: textResult.pageCount,
                textCharCount: textResult.text.length,
                overallConfidence: validation.confidence,
                signaturesJson: JSON.stringify(signatures),
                metaJson: JSON.stringify({
                    classifyReasons: classified.reasons,
                    textMethod: textResult.method,
                    textAdequate: textResult.adequate,
                    declaredType,
                    noaVisionUsed: noaTitleMissing,
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
                classifiedDocType: documentType,
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
            classifiedDocType: documentType,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Document AI processing failed";
        const permanent = isPermanentInvalidPdfError(err) || (err as { permanent?: boolean })?.permanent === true;
        const category = permanent ? "INVALID_PDF_STRUCTURE" : "DOC_AI_JOB_FAILED";
        runtimeLog(permanent ? "WARNING" : "ERROR", {
            module: "doc-ai",
            category,
            message: `job ${jobId} failed`,
            shipmentId: job.shipmentLeadId,
            retryEligible: !permanent && (job.attempts || 0) < 3,
            detail: msg,
        });
        const errorMessage = permanent
            ? `INVALID_PDF_STRUCTURE: ${msg}`.slice(0, 1000)
            : msg.slice(0, 1000);
        await prisma.aiDocumentJob
            .update({
                where: { jobId },
                data: {
                    status: "FAILED",
                    errorMessage,
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
