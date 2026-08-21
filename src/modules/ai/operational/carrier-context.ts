import { prisma } from "../../../config/database.js";
import { carrierService } from "../../carriers/services/carrier.service.js";
import { CARRIER_DOC_TYPES } from "../../carriers/constants.js";
import { normalizeDot, normalizeMc, namesSoftEqual } from "../documents/normalize.js";
import { evaluateInsuranceRules, type RuleCheck } from "../documents/rules.js";
import { prioritizeRecommendations, recommendation } from "./recommendations.js";
import type {
    CarrierOperationalSummary,
    CarrierReadiness,
    ComplianceLight,
    DocumentChecklistItem,
    DocSlotStatus,
    OperationalMismatch,
    OperationalRecommendation,
    OperationalSource,
} from "./types.js";

export type OperationalActor = { userId: string; role: string };

/** Operational readiness matrix (broader than onboarding REQUIRED_CARRIER_DOC_TYPES). */
export const OPERATIONAL_CARRIER_SLOTS = [
    { slot: "W9", types: [CARRIER_DOC_TYPES.W9] },
    { slot: "COI", types: [CARRIER_DOC_TYPES.COI, CARRIER_DOC_TYPES.INSURANCE] },
    { slot: "MC_AUTHORITY", types: [CARRIER_DOC_TYPES.MC_AUTHORITY] },
    { slot: "AGREEMENT", types: [CARRIER_DOC_TYPES.BROKER_CARRIER_AGREEMENT] },
    { slot: "NOA", types: [CARRIER_DOC_TYPES.NOA] },
] as const;

type DocRow = {
    documentId: string;
    documentType: string;
    originalFilename: string;
    status: string;
    uploadedAt: Date;
};

type JobBundle = {
    documentId: string;
    classifiedDocType: string | null;
    declaredDocType: string | null;
    overallStatus: string | null;
    trafficLight: string | null;
    checksJson: string | null;
    matchesJson: string | null;
    warningsJson: string | null;
    errorsJson: string | null;
    fields: Record<string, string | null>;
    signaturesJson: string | null;
};

function parseJsonArray(raw: string | null): Array<Record<string, unknown>> {
    if (!raw) return [];
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

function mapValidationToSlot(overall: string | null, hasDoc: boolean): DocSlotStatus {
    if (!hasDoc) return "MISSING";
    if (!overall) return "PRESENT";
    const u = overall.toUpperCase();
    if (u === "VALID") return "VALID";
    if (u === "EXPIRED") return "EXPIRED";
    if (u === "INVALID" || u === "MISMATCH" || u === "FAILED") return "INVALID";
    if (u === "UNSIGNED" || u === "REVIEW_REQUIRED" || u === "NOT_ENOUGH_INFORMATION") {
        return "REVIEW_REQUIRED";
    }
    return "PRESENT";
}

function signatureHint(signaturesJson: string | null): string | null {
    if (!signaturesJson) return null;
    try {
        const arr = JSON.parse(signaturesJson) as Array<{ status?: string; role?: string }>;
        if (!Array.isArray(arr) || !arr.length) return null;
        return arr.map((s) => `${s.role || "SIG"}:${s.status || "?"}`).join(", ");
    } catch {
        return null;
    }
}

async function loadLatestJobsForCarrier(carrierId: string): Promise<Map<string, JobBundle>> {
    const jobs = await prisma.aiDocumentJob.findMany({
        where: {
            carrierId,
            status: { in: ["SUCCEEDED", "CACHED"] },
            validation: { isNot: null },
        },
        orderBy: { completedAt: "desc" },
        take: 40,
        include: {
            validation: true,
            extraction: { include: { fields: true } },
        },
    });
    const byDoc = new Map<string, JobBundle>();
    for (const j of jobs) {
        if (byDoc.has(j.documentId)) continue;
        const fields: Record<string, string | null> = {};
        for (const f of j.extraction?.fields || []) {
            fields[f.fieldKey] = f.valueNormalized || f.valueText;
        }
        byDoc.set(j.documentId, {
            documentId: j.documentId,
            classifiedDocType: j.classifiedDocType,
            declaredDocType: j.declaredDocType,
            overallStatus: j.validation?.overallStatus || null,
            trafficLight: j.validation?.trafficLight || null,
            checksJson: j.validation?.checksJson || null,
            matchesJson: j.validation?.matchesJson || null,
            warningsJson: j.validation?.warningsJson || null,
            errorsJson: j.validation?.errorsJson || null,
            fields,
            signaturesJson: j.extraction?.signaturesJson || null,
        });
    }
    return byDoc;
}

function pickDocForSlot(docs: DocRow[], types: readonly string[]): DocRow | null {
    return docs.find((d) => types.includes(d.documentType)) || null;
}

function buildChecklist(
    docs: DocRow[],
    jobs: Map<string, JobBundle>
): DocumentChecklistItem[] {
    return OPERATIONAL_CARRIER_SLOTS.map((slot) => {
        const doc = pickDocForSlot(docs, slot.types);
        const job = doc ? jobs.get(doc.documentId) : null;
        const status = mapValidationToSlot(job?.overallStatus || null, Boolean(doc));
        let reason = "No current document on file";
        if (doc && !job) reason = "Document present; Document AI validation not available yet";
        if (doc && job) {
            reason = `Validation: ${job.overallStatus || "unknown"}`;
            const errs = parseJsonArray(job.errorsJson);
            const warns = parseJsonArray(job.warningsJson);
            const checks = parseJsonArray(job.checksJson).filter((c) => c.ok === false);
            const detail = [...errs, ...warns, ...checks]
                .map((c) => String(c.message || c.id || ""))
                .filter(Boolean)
                .slice(0, 3);
            if (detail.length) reason = detail.join("; ");
        }
        return {
            documentType: slot.types[0],
            slot: slot.slot,
            status,
            validationStatus: job?.overallStatus || null,
            trafficLight: job?.trafficLight || null,
            expiration: job?.fields.policyExp || job?.fields.expirationDate || null,
            signatureStatus: signatureHint(job?.signaturesJson || null),
            reason,
            documentId: doc?.documentId || null,
        };
    });
}

function collectInsuranceIssues(job: JobBundle | null): RuleCheck[] {
    if (!job) return [];
    const fromStored = parseJsonArray(job.checksJson).filter((c) =>
        String(c.id || "").startsWith("BR-INS")
    ) as unknown as RuleCheck[];
    if (fromStored.length) return fromStored;
    return evaluateInsuranceRules({
        autoLiabilityLimit: job.fields.autoLiabilityLimit,
        cargoLimit: job.fields.cargoLimit,
        glLimit: job.fields.glLimit,
        elLimit: job.fields.elLimit,
        certificateHolder: job.fields.certificateHolder,
        policyExp: job.fields.policyExp,
    });
}

function buildCrossDocMismatches(
    carrier: { legalName: string; mcNumber: string | null; dotNumber: string | null },
    jobs: Map<string, JobBundle>,
    docs: DocRow[]
): OperationalMismatch[] {
    const out: OperationalMismatch[] = [];
    const authDoc = pickDocForSlot(docs, [CARRIER_DOC_TYPES.MC_AUTHORITY]);
    const coiDoc =
        pickDocForSlot(docs, [CARRIER_DOC_TYPES.COI]) ||
        pickDocForSlot(docs, [CARRIER_DOC_TYPES.INSURANCE]);
    const auth = authDoc ? jobs.get(authDoc.documentId) : null;
    const coi = coiDoc ? jobs.get(coiDoc.documentId) : null;

    const authMc = normalizeMc(auth?.fields.mcNumber);
    const coiMc = normalizeMc(coi?.fields.mcNumber || coi?.fields.carrierMc);
    const gosMc = normalizeMc(carrier.mcNumber);
    const authDot = normalizeDot(auth?.fields.dotNumber);
    const coiDot = normalizeDot(coi?.fields.dotNumber || coi?.fields.carrierDot);
    const gosDot = normalizeDot(carrier.dotNumber);

    const mcStatus =
        authMc && coiMc && gosMc
            ? authMc === coiMc && coiMc === gosMc
                ? "MATCH"
                : "CRITICAL_MISMATCH"
            : authMc && coiMc
              ? authMc === coiMc
                  ? "MATCH"
                  : "CRITICAL_MISMATCH"
              : authMc && gosMc
                ? authMc === gosMc
                    ? "MATCH"
                    : "CRITICAL_MISMATCH"
                : coiMc && gosMc
                  ? coiMc === gosMc
                      ? "MATCH"
                      : "CRITICAL_MISMATCH"
                  : "MISSING";

    out.push({
        id: "CROSS-MC",
        field: "MC",
        status: mcStatus,
        message: `MC Authority=${authMc || "—"} · COI=${coiMc || "—"} · GreenOS=${gosMc || "—"} → ${mcStatus}`,
        values: { authority: authMc, coi: coiMc, greenOs: gosMc },
    });

    const dotStatus =
        authDot && coiDot && gosDot
            ? authDot === coiDot && coiDot === gosDot
                ? "MATCH"
                : "CRITICAL_MISMATCH"
            : authDot && gosDot
              ? authDot === gosDot
                  ? "MATCH"
                  : "CRITICAL_MISMATCH"
              : coiDot && gosDot
                ? coiDot === gosDot
                    ? "MATCH"
                    : "CRITICAL_MISMATCH"
                : "MISSING";

    out.push({
        id: "CROSS-DOT",
        field: "DOT",
        status: dotStatus,
        message: `DOT Authority=${authDot || "—"} · COI=${coiDot || "—"} · GreenOS=${gosDot || "—"} → ${dotStatus}`,
        values: { authority: authDot, coi: coiDot, greenOs: gosDot },
    });

    const authName = auth?.fields.legalName || null;
    const coiName = coi?.fields.insuredName || coi?.fields.legalName || null;
    if (authName || coiName) {
        const nameOk =
            (!authName || namesSoftEqual(authName, carrier.legalName)) &&
            (!coiName || namesSoftEqual(coiName, carrier.legalName));
        out.push({
            id: "CROSS-NAME",
            field: "legalName",
            status: nameOk ? "MATCH" : "MISMATCH",
            message: nameOk
                ? "Legal name soft-matches across documents and GreenOS"
                : "Legal name soft mismatch across Authority/COI/GreenOS",
            values: { authority: authName, coi: coiName, greenOs: carrier.legalName },
        });
    }

    return out;
}

function deriveCompliance(
    checklist: DocumentChecklistItem[],
    mismatches: OperationalMismatch[],
    insuranceChecks: RuleCheck[]
): { light: ComplianceLight; summary: string; readiness: CarrierReadiness } {
    const critical =
        mismatches.some((m) => m.status === "CRITICAL_MISMATCH") ||
        insuranceChecks.some((c) => c.status === "BELOW_REQUIREMENT" || c.status === "EXPIRED") ||
        checklist.some((d) => d.status === "EXPIRED" || d.status === "INVALID");

    const missingRequired = checklist.filter((d) => d.status === "MISSING");
    const needsReview =
        checklist.some((d) => d.status === "REVIEW_REQUIRED" || d.status === "PRESENT") ||
        insuranceChecks.some((c) => !c.ok && c.status !== "SKIPPED") ||
        mismatches.some((m) => m.status === "MISMATCH" || m.status === "MISSING");

    if (critical || missingRequired.length > 0) {
        const parts: string[] = [];
        if (critical) parts.push("Critical mismatch or failed insurance requirement");
        if (missingRequired.length) {
            parts.push(`Missing: ${missingRequired.map((d) => d.slot).join(", ")}`);
        }
        return {
            light: "RED",
            summary: parts.join(". ") || "Not ready",
            readiness: "NOT_READY",
        };
    }

    if (needsReview) {
        return {
            light: "REVIEW",
            summary: "One or more documents require human review or validation is incomplete",
            readiness: "REVIEW_REQUIRED",
        };
    }

    const allValid = checklist.every((d) => d.status === "VALID");
    if (!allValid) {
        // Incomplete information → REVIEW, never GREEN
        return {
            light: "REVIEW",
            summary: "Required information incomplete — cannot confirm GREEN",
            readiness: "REVIEW_REQUIRED",
        };
    }

    return {
        light: "GREEN",
        summary: "All required documents valid. No critical mismatches. Insurance requirements satisfied.",
        readiness: "READY",
    };
}

/**
 * Build read-only carrier operational summary. ACL enforced before assembly.
 */
export async function buildCarrierOperationalSummary(
    actor: OperationalActor,
    carrierId: string
): Promise<CarrierOperationalSummary> {
    await carrierService.assertCarrierAccess(carrierId, actor);

    const carrier = await prisma.carrier.findUnique({
        where: { carrierId },
        select: {
            carrierId: true,
            legalName: true,
            dbaName: true,
            mcNumber: true,
            dotNumber: true,
            email: true,
            phone: true,
            city: true,
            state: true,
            status: true,
            onboardingStatus: true,
            assignedBrokerId: true,
            updatedAt: true,
        },
    });
    if (!carrier) {
        throw Object.assign(new Error("Carrier not found"), { status: 404 });
    }

    const docs = await prisma.carrierDocument.findMany({
        where: { carrierId, status: "CURRENT" },
        orderBy: [{ documentType: "asc" }, { version: "desc" }],
        select: {
            documentId: true,
            documentType: true,
            originalFilename: true,
            status: true,
            uploadedAt: true,
        },
    });

    const jobs = await loadLatestJobsForCarrier(carrierId);
    const checklist = buildChecklist(docs, jobs);
    const mismatches = buildCrossDocMismatches(carrier, jobs, docs);

    const coiDoc =
        pickDocForSlot(docs, [CARRIER_DOC_TYPES.COI]) ||
        pickDocForSlot(docs, [CARRIER_DOC_TYPES.INSURANCE]);
    const coiJob = coiDoc ? jobs.get(coiDoc.documentId) || null : null;
    const insuranceChecks = collectInsuranceIssues(coiJob);

    const { light, summary, readiness } = deriveCompliance(checklist, mismatches, insuranceChecks);

    const reviewItems: string[] = [];
    const warnings: string[] = [];
    const recommendations: OperationalRecommendation[] = [];

    for (const item of checklist) {
        if (item.status === "MISSING") {
            reviewItems.push(`${item.slot} missing`);
            recommendations.push(
                recommendation(
                    `req-${item.slot}`,
                    `Request / upload ${item.slot}`,
                    item.reason,
                    item.slot === "MC_AUTHORITY" || item.slot === "COI" ? "HIGH" : "HIGH",
                    item.documentId || undefined
                )
            );
        } else if (item.status === "EXPIRED") {
            reviewItems.push(`${item.slot} expired${item.expiration ? ` (${item.expiration})` : ""}`);
            recommendations.push(
                recommendation(
                    `exp-${item.slot}`,
                    `Request updated ${item.slot}`,
                    item.reason,
                    "CRITICAL",
                    item.documentId || undefined
                )
            );
        } else if (item.status === "INVALID") {
            reviewItems.push(`${item.slot} invalid — ${item.reason}`);
            recommendations.push(
                recommendation(`inv-${item.slot}`, `Review ${item.slot}`, item.reason, "CRITICAL", item.documentId || undefined)
            );
        } else if (item.status === "REVIEW_REQUIRED" || item.status === "PRESENT") {
            reviewItems.push(`${item.slot}: ${item.reason}`);
            recommendations.push(
                recommendation(`rev-${item.slot}`, `Review ${item.slot}`, item.reason, "MEDIUM", item.documentId || undefined)
            );
        }
    }

    for (const m of mismatches) {
        if (m.status === "CRITICAL_MISMATCH") {
            reviewItems.push(m.message);
            recommendations.push(
                recommendation(
                    m.id,
                    "Do not approve until the MC/DOT discrepancy is reviewed.",
                    m.message,
                    "CRITICAL",
                    "cross_document"
                )
            );
        } else if (m.status === "MISMATCH") {
            warnings.push(m.message);
            recommendations.push(
                recommendation(m.id, "Review name/identity soft mismatch", m.message, "HIGH", "cross_document")
            );
        }
    }

    for (const c of insuranceChecks) {
        if (c.ok || c.status === "SKIPPED") continue;
        const msg = c.message;
        reviewItems.push(msg);
        recommendations.push(
            recommendation(
                c.id,
                c.status === "BELOW_REQUIREMENT"
                    ? "Request COI meeting Green Logistics insurance minima"
                    : c.status === "EXPIRED"
                      ? "Request updated COI"
                      : "Review insurance certificate",
                msg,
                c.status === "BELOW_REQUIREMENT" || c.status === "EXPIRED" ? "CRITICAL" : "HIGH",
                coiDoc?.documentId
            )
        );
    }

    const sources: OperationalSource[] = [
        {
            type: "carrier",
            id: carrier.carrierId,
            label: carrier.legalName,
            carrierId: carrier.carrierId,
        },
        ...docs.map((d) => ({
            type: "carrier_document",
            id: d.documentId,
            label: `${d.documentType}: ${d.originalFilename}`,
            carrierId,
        })),
    ];
    for (const [, job] of jobs) {
        if (job.overallStatus) {
            sources.push({
                type: "document_validation",
                id: job.documentId,
                label: `${job.classifiedDocType || job.declaredDocType || "doc"} validation`,
                carrierId,
            });
        }
    }

    const nextBestActions = prioritizeRecommendations(recommendations).slice(0, 8);

    return {
        carrier: {
            carrierId: carrier.carrierId,
            legalName: carrier.legalName,
            dbaName: carrier.dbaName,
            mcNumber: carrier.mcNumber,
            dotNumber: carrier.dotNumber,
            email: carrier.email,
            phone: carrier.phone,
            city: carrier.city,
            state: carrier.state,
            status: carrier.status,
            onboardingStatus: carrier.onboardingStatus,
            updatedAt: carrier.updatedAt.toISOString(),
        },
        readiness,
        compliance: { light, summary },
        documents: checklist,
        missingDocuments: checklist.filter((d) => d.status === "MISSING").map((d) => d.slot),
        reviewItems: [...new Set(reviewItems)],
        mismatches,
        warnings: [...new Set(warnings)],
        recommendations: nextBestActions,
        nextBestActions,
        sources,
        answerMode: "OPERATIONAL",
        groundingLabel: "Based on GreenOS data",
    };
}

/** Pure helper for golden tests — derive readiness from checklist/mismatches/insurance. */
export function _deriveComplianceForTests(
    checklist: DocumentChecklistItem[],
    mismatches: OperationalMismatch[],
    insuranceChecks: RuleCheck[]
) {
    return deriveCompliance(checklist, mismatches, insuranceChecks);
}
