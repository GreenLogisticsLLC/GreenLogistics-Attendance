/**
 * Phase 2B real-document verification (offline pipeline).
 * Reads reference files from dok/ — does NOT commit them.
 *
 * Usage:
 *   npx tsx scripts/verify-doc-ai-phase2b.ts
 *   $env:DOC_AI_VISION="true"; npx tsx scripts/verify-doc-ai-phase2b.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { extractDocumentText } from "../src/modules/ai/documents/text-extract.js";
import { classifyDocumentText } from "../src/modules/ai/documents/classify.js";
import { extractFieldsForType } from "../src/modules/ai/documents/extract.js";
import {
    analyzeSignatureScenario,
    analyzeSignatureWithVision,
    analyzeSignaturesFromText,
    podOverallFromSignature,
} from "../src/modules/ai/documents/signature.js";
import { validateDocument } from "../src/modules/ai/documents/validate.js";
import { evaluateInsuranceRules } from "../src/modules/ai/documents/rules.js";
import { fieldsToMap } from "../src/modules/ai/documents/extract.js";
import { normalizeMc, normalizeDot, namesSoftEqual, redactTin } from "../src/modules/ai/documents/normalize.js";
import { prisma } from "../src/config/database.js";
import { documentAiJobService } from "../src/modules/ai/documents/job.service.js";
import { processDocumentJob } from "../src/modules/ai/documents/processor.js";
import { carrierStorageService } from "../src/modules/carriers/services/carrier-storage.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOK = path.resolve(__dirname, "..", "..", "dok");
// OneDrive path used by user
const DOK_ALT = "c:\\Users\\37493\\OneDrive\\Рабочий стол\\dok";
const dokRoot = fs.existsSync(DOK_ALT) ? DOK_ALT : DOK;

type Report = Record<string, unknown>;

async function analyzeFile(fileName: string, declared?: string): Promise<Report> {
    const abs = path.join(dokRoot, fileName);
    if (!fs.existsSync(abs)) return { error: "missing_file", fileName };
    const textResult = await extractDocumentText(abs);
    const classified = classifyDocumentText({
        text: textResult.text,
        declaredType: declared,
        fileName,
    });
    let fields = extractFieldsForType(classified.documentType as never, textResult.text);
    let signatures = analyzeSignaturesFromText({
        text: textResult.text,
        documentType: classified.documentType,
    });

    const ext = path.extname(abs).toLowerCase();
    const visionOn = process.env.DOC_AI_VISION === "true";
    if (
        visionOn &&
        [".jpg", ".jpeg", ".png", ".webp"].includes(ext) &&
        (classified.documentType === "W9" ||
            classified.documentType === "POD" ||
            classified.documentType === "NOA" ||
            !textResult.adequate)
    ) {
        const b64 = fs.readFileSync(abs).toString("base64");
        const mime = ext === ".png" ? "image/png" : "image/jpeg";
        if (classified.documentType === "W9" && !textResult.adequate) {
            const { extractW9FieldsWithVision } = await import(
                "../src/modules/ai/documents/vision-extract.js"
            );
            const vf = await extractW9FieldsWithVision({ imageBase64: b64, mimeType: mime });
            if (vf.length) fields = vf;
        }
        const role =
            classified.documentType === "W9"
                ? "TAXPAYER"
                : classified.documentType === "NOA"
                  ? "ASSIGNOR"
                  : "RECEIVER";
        const v = await analyzeSignatureWithVision({ role, imageBase64: b64, mimeType: mime });
        signatures = [v];
    }

    const greenOs = {
        legalName: "I GET AROUND TRANSPORTATION LLC",
        mcNumber: "1820780",
        dotNumber: "4575864",
        loadNumber: "75246",
        carrierMc: "1820780",
        carrierDot: "4575864",
        carrierName: "I GET AROUND TRANSPORTATION LLC",
    };

    const validation = validateDocument({
        documentType: classified.documentType,
        classifyConfidence: classified.confidence,
        requiresBoundaryReview: classified.requiresBoundaryReview || !textResult.adequate,
        fields,
        signatures,
        greenOs,
    });

    const map = fieldsToMap(fields);
    const tinFields = fields.filter((f) => f.fieldKey === "tin" || f.fieldKey === "tinType");
    const tinLeak = JSON.stringify({ fields: tinFields, validation }).match(/\b\d{2}-?\d{7}\b/);

    return {
        fileName,
        textChars: textResult.text.length,
        textAdequate: textResult.adequate,
        classified: classified.documentType,
        classifyConfidence: classified.confidence,
        classifyReasons: classified.reasons,
        fields: map,
        fieldDetails: fields.map((f) => ({
            key: f.fieldKey,
            value: f.valueText,
            normalized: f.valueNormalized,
            status: f.fieldStatus,
            confidence: f.confidence,
        })),
        signatures,
        validation: {
            overallStatus: validation.overallStatus,
            trafficLight: validation.trafficLight,
            requiresReview: validation.requiresReview,
            checks: validation.checks,
            matches: validation.matches,
            warnings: validation.warnings,
            errors: validation.errors,
            levels: validation.levels,
        },
        tinRedactedOk: !tinLeak,
        greenOsMatchSample: {
            mcDoc: normalizeMc(map.mcNumber || map.carrierMc),
            mcGos: normalizeMc(greenOs.mcNumber),
            mcStatus:
                normalizeMc(map.mcNumber || map.carrierMc) === normalizeMc(greenOs.mcNumber)
                    ? "MATCH"
                    : normalizeMc(map.mcNumber || map.carrierMc)
                      ? "CRITICAL_MISMATCH"
                      : "MISSING",
            dotDoc: normalizeDot(map.dotNumber || map.carrierDot),
            dotGos: normalizeDot(greenOs.dotNumber),
            nameSoft: namesSoftEqual(
                map.legalName || map.businessName || map.carrier || map.insuredName,
                greenOs.legalName
            ),
        },
    };
}

async function verifyPodFixtures(): Promise<Report> {
    const cases = [
        { name: "A_EMPTY", scenario: "EMPTY" as const, neverValid: true },
        { name: "B_HANDWRITTEN", scenario: "HANDWRITTEN" as const, neverValid: false },
        { name: "C_TYPED", scenario: "TYPED_ONLY" as const, neverValid: true },
        { name: "D_UNCERTAIN", scenario: "UNCERTAIN" as const, neverValid: true },
    ];
    const out: Report[] = [];
    for (const c of cases) {
        const sig = analyzeSignatureScenario(c.scenario);
        const hint = podOverallFromSignature(sig);
        const v = validateDocument({
            documentType: "POD",
            classifyConfidence: 0.95,
            fields: [
                {
                    fieldKey: "deliveryDate",
                    valueText: "08/20/2026",
                    valueNormalized: "08/20/2026",
                    confidence: 0.9,
                    page: 1,
                    source: "page_1",
                    method: "fixture",
                    fieldStatus: "FIELD_FOUND",
                },
                {
                    fieldKey: "receiverName",
                    valueText: "John Smith",
                    valueNormalized: "John Smith",
                    confidence: 0.9,
                    page: 1,
                    source: "page_1",
                    method: "fixture",
                    fieldStatus: "FIELD_FOUND",
                },
            ],
            signatures: [sig],
        });
        out.push({
            case: c.name,
            sigStatus: sig.status,
            hint: hint.overallHint,
            overallStatus: v.overallStatus,
            neverValidOk: c.neverValid ? v.overallStatus !== "VALID" : true,
            validWhenExpected:
                !c.neverValid && c.scenario === "HANDWRITTEN"
                    ? hint.overallHint === "VALID_SIG"
                    : true,
        });
    }
    return { podFixtures: out };
}

async function ensureDocAiTables(): Promise<void> {
    // Drop incomplete stubs then recreate from Phase 2B SQL (local verification only).
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "document_extraction_fields"`);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "document_validation_results"`);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "ai_document_extractions"`);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "ai_document_jobs"`);

    const statements = [
        `CREATE TABLE "ai_document_jobs" (
            "job_id" TEXT NOT NULL PRIMARY KEY,
            "document_source" TEXT NOT NULL,
            "document_id" TEXT NOT NULL,
            "carrier_id" TEXT,
            "shipment_lead_id" TEXT,
            "actor_user_id" TEXT NOT NULL,
            "checksum" TEXT NOT NULL,
            "declared_doc_type" TEXT,
            "classified_doc_type" TEXT,
            "status" TEXT NOT NULL DEFAULT 'QUEUED',
            "attempts" INTEGER NOT NULL DEFAULT 0,
            "error_message" TEXT,
            "provider_model" TEXT,
            "cached_from_job_id" TEXT,
            "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "started_at" DATETIME,
            "completed_at" DATETIME
        )`,
        `CREATE TABLE "ai_document_extractions" (
            "extraction_id" TEXT NOT NULL PRIMARY KEY,
            "job_id" TEXT NOT NULL,
            "document_type" TEXT NOT NULL,
            "page_count" INTEGER,
            "text_char_count" INTEGER,
            "overall_confidence" REAL,
            "signatures_json" TEXT,
            "meta_json" TEXT,
            "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE UNIQUE INDEX "ai_document_extractions_job_id_key" ON "ai_document_extractions"("job_id")`,
        `CREATE TABLE "document_extraction_fields" (
            "field_id" TEXT NOT NULL PRIMARY KEY,
            "extraction_id" TEXT NOT NULL,
            "field_key" TEXT NOT NULL,
            "value_text" TEXT,
            "value_normalized" TEXT,
            "value_protected" TEXT,
            "confidence" REAL,
            "page" INTEGER,
            "source" TEXT,
            "method" TEXT,
            "field_status" TEXT NOT NULL DEFAULT 'FIELD_FOUND'
        )`,
        `CREATE TABLE "document_validation_results" (
            "validation_id" TEXT NOT NULL PRIMARY KEY,
            "job_id" TEXT NOT NULL,
            "overall_status" TEXT NOT NULL,
            "traffic_light" TEXT NOT NULL,
            "levels_json" TEXT,
            "checks_json" TEXT,
            "matches_json" TEXT,
            "warnings_json" TEXT,
            "errors_json" TEXT,
            "requires_review" BOOLEAN NOT NULL DEFAULT false,
            "reviewer_user_id" TEXT,
            "reviewed_at" DATETIME,
            "review_decision" TEXT,
            "review_notes" TEXT,
            "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE UNIQUE INDEX "document_validation_results_job_id_key" ON "document_validation_results"("job_id")`,
    ];
    for (const s of statements) {
        await prisma.$executeRawUnsafe(s);
    }
    const tables = await prisma.$queryRawUnsafe(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ai_document%' OR name LIKE 'document_%'"
    );
    console.log("[verify] doc-ai tables ready", tables);
}

async function verifyAsyncCacheReview(): Promise<Report> {
    await ensureDocAiTables();
    // Use admin-like actor + temp carrier doc from MC letter (no PII commit)
    const admin = await prisma.user.findFirst({
        where: { isActive: true },
        include: { role: true },
    });
    if (!admin) return { async: "SKIPPED_NO_USER" };

    let carrier = await prisma.carrier.findFirst({
        orderBy: { updatedAt: "desc" },
        select: { carrierId: true, legalName: true, mcNumber: true, assignedBrokerId: true },
    });
    let createdCarrier = false;
    if (!carrier) {
        carrier = await prisma.carrier.create({
            data: {
                legalName: "I GET AROUND TRANSPORTATION LLC",
                email: `verify-${Date.now()}@example.invalid`,
                mcNumber: "1820780",
                dotNumber: "4575864",
                status: "ACTIVE",
                onboardingStatus: "APPROVED",
            },
            select: { carrierId: true, legalName: true, mcNumber: true, assignedBrokerId: true },
        });
        createdCarrier = true;
    }
    const src = path.join(dokRoot, "GRANTED MC LETTER 1820780 (1).pdf");
    if (!fs.existsSync(src)) {
        return { async: "SKIPPED_NO_MC_FILE" };
    }
    const role = admin.role?.roleName || "Administrator";
    const actor = { userId: admin.userId, role };
    const buf = fs.readFileSync(src);
    const tmp = path.join(process.cwd(), "uploads", "_verify_tmp_mc.pdf");
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, buf);

    const stored = carrierStorageService.storeFromTemp({
        carrierId: carrier.carrierId,
        documentType: "MC_AUTHORITY",
        originalName: "verify-mc-authority.pdf",
        mimeType: "application/pdf",
        tempPath: tmp,
        version: 99,
    });

    const doc = await prisma.carrierDocument.create({
        data: {
            carrierId: carrier.carrierId,
            documentType: "MC_AUTHORITY",
            originalFilename: "verify-mc-authority.pdf",
            storageKey: stored.storageKey,
            mimeType: "application/pdf",
            fileSize: stored.fileSize,
            checksum: stored.checksum,
            uploadedBy: "VERIFY",
            status: "CURRENT",
            version: 99,
        },
    });

    const beforeMc = carrier.mcNumber;
    const beforeName = carrier.legalName;

    const t0 = Date.now();
    const q1 = await documentAiJobService.enqueue({
        actor,
        documentSource: "CARRIER",
        documentId: doc.documentId,
    });
    const enqueueMs = Date.now() - t0;
    // Wait for processing
    let job1 = await documentAiJobService.getJob(actor, q1.jobId);
    for (let i = 0; i < 30 && !["SUCCEEDED", "CACHED", "FAILED"].includes(job1.status); i++) {
        await new Promise((r) => setTimeout(r, 500));
        job1 = await documentAiJobService.getJob(actor, q1.jobId);
    }

    const q2 = await documentAiJobService.enqueue({
        actor,
        documentSource: "CARRIER",
        documentId: doc.documentId,
    });
    let job2 = await documentAiJobService.getJob(actor, q2.jobId);
    for (let i = 0; i < 30 && !["SUCCEEDED", "CACHED", "FAILED"].includes(job2.status); i++) {
        await new Promise((r) => setTimeout(r, 500));
        // force process if still queued
        if (job2.status === "QUEUED") await processDocumentJob(q2.jobId);
        job2 = await documentAiJobService.getJob(actor, q2.jobId);
    }

    const accept = await documentAiJobService.submitReview(actor, q1.jobId, {
        decision: "ACCEPT",
        notes: "verify accept",
    });
    const reject = await documentAiJobService.submitReview(actor, q1.jobId, {
        decision: "REJECT",
        notes: "verify reject",
    });
    const changes = await documentAiJobService.submitReview(actor, q1.jobId, {
        decision: "REQUEST_CHANGES",
        notes: "verify changes",
    });

    const carrierAfter = await prisma.carrier.findUnique({
        where: { carrierId: carrier.carrierId },
        select: { legalName: true, mcNumber: true, dotNumber: true, status: true, assignedBrokerId: true },
    });

    // cleanup verification doc (keep carrier)
    await prisma.documentExtractionField.deleteMany({
        where: { extraction: { job: { documentId: doc.documentId } } },
    }).catch(() => null);
    await prisma.aiDocumentExtraction.deleteMany({ where: { job: { documentId: doc.documentId } } }).catch(() => null);
    await prisma.documentValidationResult.deleteMany({ where: { job: { documentId: doc.documentId } } }).catch(() => null);
    await prisma.aiDocumentJob.deleteMany({ where: { documentId: doc.documentId } }).catch(() => null);
    await prisma.carrierDocument.delete({ where: { documentId: doc.documentId } }).catch(() => null);
    try {
        fs.unlinkSync(stored.absolutePath);
    } catch {
        /* ignore */
    }
    if (createdCarrier) {
        await prisma.carrier.delete({ where: { carrierId: carrier.carrierId } }).catch(() => null);
    }

    return {
        enqueueMs,
        nonBlocking: enqueueMs < 2000,
        createdCarrier,
        job1: { status: job1.status, classified: job1.classifiedDocType, validation: job1.validation?.overallStatus },
        job2: { status: job2.status, cached: job2.status === "CACHED" || Boolean(job2.cachedFromJobId) },
        review: {
            accept: accept.reviewDecision,
            reject: reject.reviewDecision,
            requestChanges: changes.reviewDecision,
        },
        masterDataUnchanged:
            carrierAfter?.legalName === beforeName &&
            carrierAfter?.mcNumber === beforeMc &&
            carrierAfter?.assignedBrokerId === carrier.assignedBrokerId,
    };
}

async function main() {
    const report: Report = {
        dokRoot,
        visionEnv: process.env.DOC_AI_VISION || "false",
        timestamp: new Date().toISOString(),
    };

    report.w9 = await analyzeFile(
        "1779981361063-dfd02695-9a5d-423b-91f1-43d67a07679f_1 (1).jpg",
        "W9"
    );
    report.coi = await analyzeFile("EOI - GREEN LOGISTICS  08132026.pdf", "COI");
    if (report.coi && typeof report.coi === "object" && "fields" in report.coi) {
        const f = (report.coi as { fields: Record<string, string | null> }).fields;
        (report.coi as Report).insuranceRules = evaluateInsuranceRules({
            autoLiabilityLimit: f.autoLiabilityLimit,
            cargoLimit: f.cargoLimit,
            glLimit: f.glLimit,
            certificateHolder: f.certificateHolder,
            policyExp: f.policyExp,
        });
    }
    report.evidenceNoHolder = await analyzeFile("EvidenceofInsurance23121929 (1) (1).pdf", "COI");
    report.mcAuthority = await analyzeFile("GRANTED MC LETTER 1820780 (1).pdf");
    report.bmc84FromPackage = await analyzeFile("GREEN LOGISTICS LLC package (2) (2) (1).pdf");
    // Force BMC text slice verification
    const pkgText = await extractDocumentText(path.join(dokRoot, "GREEN LOGISTICS LLC package (2) (2) (1).pdf"));
    const bmcSlice = pkgText.text.slice(pkgText.text.indexOf("BMC") >= 0 ? pkgText.text.indexOf("BMC") - 50 : 0);
    report.bmc84Classify = classifyDocumentText({ text: bmcSlice.length > 100 ? bmcSlice : pkgText.text.slice(-8000) });
    report.noa = await analyzeFile("Notice_of_Assignment (2) (1).pdf", "NOA");
    report.rateCon = await analyzeFile("75246 (1) (1).pdf");
    report.bol = await analyzeFile("BOL 75246 (1).pdf");
    report.podFixtures = await verifyPodFixtures();

    // Vision on W-9 image if enabled
    if (process.env.DOC_AI_VISION === "true") {
        const w9path = path.join(
            dokRoot,
            "1779981361063-dfd02695-9a5d-423b-91f1-43d67a07679f_1 (1).jpg"
        );
        if (fs.existsSync(w9path)) {
            const b64 = fs.readFileSync(w9path).toString("base64");
            report.w9VisionSignature = await analyzeSignatureWithVision({
                role: "TAXPAYER",
                imageBase64: b64,
                mimeType: "image/jpeg",
            });
        }
        const noaPath = path.join(dokRoot, "Notice_of_Assignment (2) (1).pdf");
        report.noaNote =
            "NOA is PDF; without rasterization vision cannot inspect pages — expect REVIEW/UNCERTAIN";
        void noaPath;
    }

    report.redactDemo = redactTin("42-2248853");
    try {
        report.asyncCacheReview = await verifyAsyncCacheReview();
    } catch (err) {
        report.asyncCacheReview = {
            error: err instanceof Error ? err.message : String(err),
        };
    }

    const outPath = path.join(process.cwd(), "docs", "PHASE-2B-VERIFICATION-RESULT.json");
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log("\nWrote", outPath);
    await prisma.$disconnect();
}

main().catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
});
