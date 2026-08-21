import type { DocAiType } from "./classify.js";
import type { ExtractedField } from "./extract.js";
import { fieldsToMap } from "./extract.js";
import {
    checkExactId,
    checkBrokerMc,
    evaluateInsuranceRules,
    type RuleCheck,
} from "./rules.js";
import { normalizeDot, normalizeLoadNumber, normalizeMc, namesSoftEqual } from "./normalize.js";
import {
    analyzeSignaturesFromText,
    podOverallFromSignature,
    type SignatureResult,
} from "./signature.js";

export type OverallStatus =
    | "VALID"
    | "REVIEW_REQUIRED"
    | "INVALID"
    | "MISMATCH"
    | "EXPIRED"
    | "UNSIGNED"
    | "MISSING_REQUIRED_FIELD"
    | "UNSUPPORTED"
    | "NOT_ENOUGH_INFORMATION"
    | "FAILED";

export type ValidationBundle = {
    documentType: DocAiType;
    overallStatus: OverallStatus;
    trafficLight: "GREEN" | "YELLOW" | "RED";
    requiresReview: boolean;
    levels: Record<string, { ok: boolean; detail: string }>;
    checks: RuleCheck[];
    matches: RuleCheck[];
    warnings: string[];
    errors: string[];
    signatures: SignatureResult[];
    confidence: number;
};

export function validateDocument(input: {
    documentType: DocAiType;
    classifyConfidence: number;
    requiresBoundaryReview?: boolean;
    fields: ExtractedField[];
    signatures?: SignatureResult[];
    greenOs?: {
        legalName?: string | null;
        mcNumber?: string | null;
        dotNumber?: string | null;
        loadNumber?: string | null;
        carrierName?: string | null;
        carrierMc?: string | null;
        carrierDot?: string | null;
    };
}): ValidationBundle {
    const map = fieldsToMap(input.fields);
    const warnings: string[] = [];
    const errors: string[] = [];
    const checks: RuleCheck[] = [];
    const matches: RuleCheck[] = [];
    const signatures =
        input.signatures ||
        analyzeSignaturesFromText({ text: "", documentType: input.documentType });

    const levels: ValidationBundle["levels"] = {
        type: {
            ok: input.documentType !== "UNKNOWN" && input.documentType !== "UNSUPPORTED",
            detail: input.documentType,
        },
        structure: { ok: input.fields.length > 0, detail: `${input.fields.length} fields` },
        completeness: { ok: true, detail: "pending" },
        signature: { ok: true, detail: "n/a" },
        greenOsMatch: { ok: true, detail: "n/a" },
        businessRules: { ok: true, detail: "n/a" },
        expiration: { ok: true, detail: "n/a" },
    };

    if (input.documentType === "UNSUPPORTED") {
        return finish("UNSUPPORTED", "RED", true, 0.9, {
            documentType: input.documentType,
            levels,
            checks,
            matches,
            warnings: ["Document type unsupported for carrier MC Authority (e.g. broker BMC-84)"],
            errors: ["UNSUPPORTED_DOCUMENT_TYPE"],
            signatures,
            classifyConfidence: input.classifyConfidence,
        });
    }

    if (input.requiresBoundaryReview || input.documentType === "UNKNOWN") {
        warnings.push("Document boundary/type review required");
        return finish("REVIEW_REQUIRED", "YELLOW", true, input.classifyConfidence, {
            documentType: input.documentType,
            levels: {
                ...levels,
                type: { ok: false, detail: "boundary_or_unknown" },
            },
            checks,
            matches,
            warnings,
            errors,
            signatures,
            classifyConfidence: input.classifyConfidence,
        });
    }

    // Required field completeness (type-specific minimal)
    const requiredKeys = requiredFieldsFor(input.documentType);
    const missing = requiredKeys.filter((k) => !map[k]);
    levels.completeness = {
        ok: missing.length === 0,
        detail: missing.length ? `missing:${missing.join(",")}` : "ok",
    };
    if (missing.length) {
        errors.push(`MISSING_REQUIRED_FIELD:${missing.join(",")}`);
        checks.push({
            id: "REQ-FIELDS",
            ok: false,
            status: "MISSING",
            message: `Missing required fields: ${missing.join(", ")}`,
        });
    }

    // GreenOS matching
    const gos = input.greenOs || {};
    if (["CARRIER_PROFILE", "MC_AUTHORITY", "COI", "INSURANCE", "W9", "NOA", "BROKER_CARRIER_AGREEMENT"].includes(input.documentType)) {
        const mcCheck = checkExactId(
            "MATCH-MC",
            "MC",
            map.mcNumber || map.carrierMc,
            gos.mcNumber || gos.carrierMc,
            normalizeMc
        );
        matches.push(mcCheck);
        const dotCheck = checkExactId(
            "MATCH-DOT",
            "DOT",
            map.dotNumber || map.carrierDot,
            gos.dotNumber || gos.carrierDot,
            normalizeDot
        );
        matches.push(dotCheck);
        if (map.legalName || map.carrierLegalName || map.businessName || map.insuredName) {
            const docName = map.legalName || map.carrierLegalName || map.businessName || map.insuredName;
            if (gos.legalName && docName && !namesSoftEqual(docName, gos.legalName)) {
                matches.push({
                    id: "MATCH-NAME",
                    ok: false,
                    status: "MISMATCH",
                    message: "Legal name soft mismatch",
                    documentValue: docName,
                    greenOsValue: gos.legalName,
                });
                warnings.push("Name mismatch — human review");
            }
        }
    }

    if (["RATE_CONFIRMATION", "BOL", "POD"].includes(input.documentType)) {
        matches.push(
            checkExactId(
                "MATCH-LOAD",
                "Load/BOL",
                map.loadNumber || map.bolNumber || map.loadOrBolId,
                gos.loadNumber,
                normalizeLoadNumber
            )
        );
        matches.push(
            checkExactId(
                "MATCH-CARRIER-MC",
                "Carrier MC",
                map.carrierMc || map.mcNumber,
                gos.carrierMc || gos.mcNumber,
                normalizeMc
            )
        );
    }

    const criticalMismatch = matches.some((m) => m.status === "CRITICAL_MISMATCH");
    levels.greenOsMatch = {
        ok: !criticalMismatch,
        detail: criticalMismatch ? "CRITICAL_MISMATCH" : "ok",
    };

    // Business rules
    if (input.documentType === "COI" || input.documentType === "INSURANCE") {
        const ins = evaluateInsuranceRules({
            autoLiabilityLimit: map.autoLiabilityLimit,
            cargoLimit: map.cargoLimit,
            glLimit: map.glLimit,
            elLimit: map.elLimit,
            certificateHolder: map.certificateHolder,
            policyExp: map.policyExp,
        });
        checks.push(...ins);
        const exp = ins.find((c) => c.id === "BR-INS-EXP");
        levels.expiration = {
            ok: !exp || exp.status === "PASS" || exp.status === "SKIPPED",
            detail: exp?.status || "n/a",
        };
        levels.businessRules = {
            ok: ins.every((c) => c.ok || c.status === "SKIPPED"),
            detail: ins.filter((c) => !c.ok && c.status !== "SKIPPED").map((c) => c.id).join(",") || "ok",
        };
    }

    if (input.documentType === "BROKER_CARRIER_AGREEMENT" || input.documentType === "RATE_CONFIRMATION") {
        checks.push(checkBrokerMc(map.brokerMc));
    }

    // Signatures
    const receiver = signatures.find((s) => s.role === "RECEIVER") || signatures[0];
    if (input.documentType === "POD") {
        const pod = receiver
            ? podOverallFromSignature(receiver)
            : { overallHint: "REVIEW_REQUIRED" as const, neverValid: true };
        levels.signature = {
            ok: pod.overallHint === "VALID_SIG",
            detail: receiver?.status || "MISSING",
        };
        if (pod.overallHint === "UNSIGNED") {
            return finish("UNSIGNED", "RED", true, input.classifyConfidence, {
                documentType: input.documentType,
                levels,
                checks,
                matches,
                warnings,
                errors: [...errors, "POD_RECEIVER_SIGNATURE_MISSING"],
                signatures,
                classifyConfidence: input.classifyConfidence,
            });
        }
        if (pod.neverValid || pod.overallHint === "REVIEW_REQUIRED") {
            return finish("REVIEW_REQUIRED", "YELLOW", true, input.classifyConfidence, {
                documentType: input.documentType,
                levels,
                checks,
                matches,
                warnings: [...warnings, receiver?.reason || "POD signature uncertain"],
                errors,
                signatures,
                classifyConfidence: input.classifyConfidence,
            });
        }
    } else if (receiver && (receiver.status === "UNCERTAIN" || receiver.status === "MISSING")) {
        if (["W9", "BROKER_CARRIER_AGREEMENT", "RATE_CONFIRMATION", "BOL"].includes(input.documentType)) {
            levels.signature = { ok: false, detail: receiver.status };
            warnings.push(receiver.reason);
        }
    } else {
        levels.signature = { ok: true, detail: receiver?.status || "n/a" };
    }

    // Low confidence fields
    const uncertainFields = input.fields.filter(
        (f) => f.fieldStatus === "FIELD_UNCERTAIN" || (f.confidence > 0 && f.confidence < 0.7)
    );
    if (uncertainFields.length) {
        warnings.push(`Uncertain fields: ${uncertainFields.map((f) => f.fieldKey).join(",")}`);
    }

    if (criticalMismatch) {
        return finish("MISMATCH", "RED", true, input.classifyConfidence, {
            documentType: input.documentType,
            levels,
            checks,
            matches,
            warnings,
            errors: [...errors, "CRITICAL_MISMATCH"],
            signatures,
            classifyConfidence: input.classifyConfidence,
        });
    }

    const failedRules = checks.filter(
        (c) => !c.ok && ["BELOW_REQUIREMENT", "EXPIRED", "MISMATCH", "FAIL"].includes(c.status)
    );
    if (failedRules.some((c) => c.status === "EXPIRED")) {
        return finish("EXPIRED", "RED", true, input.classifyConfidence, {
            documentType: input.documentType,
            levels,
            checks,
            matches,
            warnings,
            errors: [...errors, "EXPIRED"],
            signatures,
            classifyConfidence: input.classifyConfidence,
        });
    }
    if (failedRules.some((c) => c.status === "BELOW_REQUIREMENT")) {
        return finish("INVALID", "RED", true, input.classifyConfidence, {
            documentType: input.documentType,
            levels,
            checks,
            matches,
            warnings,
            errors: [...errors, "BELOW_REQUIREMENT"],
            signatures,
            classifyConfidence: input.classifyConfidence,
        });
    }
    if (failedRules.length) {
        return finish("INVALID", "RED", true, input.classifyConfidence, {
            documentType: input.documentType,
            levels,
            checks,
            matches,
            warnings,
            errors: [...errors, ...failedRules.map((c) => c.id)],
            signatures,
            classifyConfidence: input.classifyConfidence,
        });
    }

    if (missing.length) {
        return finish("MISSING_REQUIRED_FIELD", "RED", true, input.classifyConfidence, {
            documentType: input.documentType,
            levels,
            checks,
            matches,
            warnings,
            errors,
            signatures,
            classifyConfidence: input.classifyConfidence,
        });
    }

    if (warnings.length || uncertainFields.length || input.classifyConfidence < 0.85) {
        return finish("REVIEW_REQUIRED", "YELLOW", true, input.classifyConfidence, {
            documentType: input.documentType,
            levels,
            checks,
            matches,
            warnings,
            errors,
            signatures,
            classifyConfidence: input.classifyConfidence,
        });
    }

    return finish("VALID", "GREEN", false, input.classifyConfidence, {
        documentType: input.documentType,
        levels,
        checks,
        matches,
        warnings,
        errors,
        signatures,
        classifyConfidence: input.classifyConfidence,
    });
}

function requiredFieldsFor(type: DocAiType): string[] {
    switch (type) {
        case "CARRIER_PROFILE":
            return ["legalName", "mcNumber", "dotNumber"];
        case "W9":
            return ["tin", "taxClassification"];
        case "COI":
        case "INSURANCE":
            return ["autoLiabilityLimit", "cargoLimit", "policyExp", "certificateHolder"];
        case "MC_AUTHORITY":
            return ["legalName", "mcNumber", "certificateNumber"];
        case "NOA":
            return ["assignmentStatement"];
        case "RATE_CONFIRMATION":
            return ["loadNumber", "carrier", "carrierMc", "flatRate"];
        case "BOL":
            return ["bolNumber", "carrier", "commodity"];
        case "POD":
            return ["deliveryDate"];
        case "BROKER_CARRIER_AGREEMENT":
            return ["brokerMc", "carrierMc"];
        default:
            return [];
    }
}

function finish(
    overallStatus: OverallStatus,
    trafficLight: "GREEN" | "YELLOW" | "RED",
    requiresReview: boolean,
    confidence: number,
    rest: Omit<ValidationBundle, "overallStatus" | "trafficLight" | "requiresReview" | "confidence"> & {
        classifyConfidence: number;
    }
): ValidationBundle {
    const { classifyConfidence: _c, ...bundle } = rest;
    return {
        ...bundle,
        overallStatus,
        trafficLight,
        requiresReview,
        confidence,
    };
}
