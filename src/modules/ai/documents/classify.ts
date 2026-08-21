/**
 * Deterministic document type classification (structure + multi-signal).
 * Never classify BMC-84 / broker surety as carrier MC_AUTHORITY.
 */

export type DocAiType =
    | "CARRIER_PROFILE"
    | "BROKER_CARRIER_AGREEMENT"
    | "W9"
    | "INSURANCE"
    | "COI"
    | "MC_AUTHORITY"
    | "NOA"
    | "RATE_CONFIRMATION"
    | "BOL"
    | "POD"
    | "UNSUPPORTED"
    | "UNKNOWN";

export type ClassifyResult = {
    documentType: DocAiType;
    confidence: number;
    reasons: string[];
    requiresBoundaryReview: boolean;
};

function score(text: string, patterns: RegExp[]): number {
    let n = 0;
    for (const p of patterns) if (p.test(text)) n += 1;
    return n;
}

export function isBrokerBmc84OrSurety(text: string): boolean {
    const t = String(text || "");
    const hasBmc =
        /\bBMC[-\s]?84\b/i.test(t) ||
        /\bFORM\s+BMC/i.test(t) ||
        /\bBond\s+Number\b/i.test(t);
    const hasGraySurety =
        /GRAY\s+INSURANCE\s+COMPANY/i.test(t) ||
        /GRAY\s+CASUALTY/i.test(t) ||
        /Power\s+of\s+Attorney/i.test(t);
    const brokerNamed = /GREEN\s+LOGISTICS\s+LLC/i.test(t);
    const notFmcsaAuthority =
        !/Federal\s+Motor\s+Carrier\s+Safety\s+Administration/i.test(t) ||
        !/\bMC-\d{4,}-[A-Z]\b/i.test(t);
    return (hasBmc || hasGraySurety) && brokerNamed && notFmcsaAuthority;
}

export function isFmcsaMcAuthority(text: string): boolean {
    const t = String(text || "");
    if (isBrokerBmc84OrSurety(t)) return false;
    const fmcsa = /Federal\s+Motor\s+Carrier\s+Safety\s+Administration/i.test(t);
    const cert = /\bCERTIFICATE\b/i.test(t) && /\bMC-\d{4,}-[A-Z]\b/i.test(t);
    const dot = /U\.?S\.?\s*DOT\s*No/i.test(t);
    return fmcsa && cert && dot;
}

export function classifyDocumentText(input: {
    text: string;
    declaredType?: string | null;
    fileName?: string | null;
}): ClassifyResult {
    const text = String(input.text || "");
    const declared = String(input.declaredType || "").toUpperCase();
    const fileName = String(input.fileName || "").toUpperCase();
    const reasons: string[] = [];

    if (!text.trim() && !declared) {
        return {
            documentType: "UNKNOWN",
            confidence: 0.2,
            reasons: ["empty_text"],
            requiresBoundaryReview: true,
        };
    }

    // Hard negatives first
    if (isBrokerBmc84OrSurety(text)) {
        reasons.push("broker_bmc84_or_surety");
        return {
            documentType: "UNSUPPORTED",
            confidence: 0.95,
            reasons,
            requiresBoundaryReview: false,
        };
    }

    if (isFmcsaMcAuthority(text) || (/GRANTED\s+MC/i.test(fileName) && /\bMC[-\s]?\d{4,}/i.test(text))) {
        reasons.push("fmcsa_mc_authority");
        return { documentType: "MC_AUTHORITY", confidence: 0.96, reasons, requiresBoundaryReview: false };
    }

    // Rate confirmation BEFORE BOL (critical)
    const rcScore =
        score(text, [
            /LOAD\s+CONFIRMATION/i,
            /rate\s+confirmation\s+not\s+a\s+BOL/i,
            /This\s+is\s+a\s+rate\s+confirmation\s+not\s+a\s+BOL/i,
            /Flat\s+Rate/i,
            /LOAD\s+NO\s*:/i,
        ]) + (/RATE\s*CON/i.test(fileName) || /CONFIRMATION/i.test(fileName) ? 1 : 0);
    if (rcScore >= 2 || /rate\s+confirmation\s+not\s+a\s+BOL/i.test(text)) {
        reasons.push("rate_confirmation_signals");
        return {
            documentType: "RATE_CONFIRMATION",
            confidence: 0.95,
            reasons,
            requiresBoundaryReview: false,
        };
    }

    const w9Score = score(text, [
        /Form\s+W-?9/i,
        /Request\s+for\s+Taxpayer\s+Identification/i,
        /Employer\s+identification\s+number/i,
        /Social\s+security\s+number/i,
        /Part\s+II\s+Certification/i,
    ]);
    if (w9Score >= 2 || declared === "W9") {
        reasons.push("w9_structure");
        return { documentType: "W9", confidence: Math.min(0.98, 0.7 + w9Score * 0.08), reasons, requiresBoundaryReview: false };
    }

    const coiScore = score(text, [
        /CERTIFICATE\s+OF\s+LIABILITY\s+INSURANCE/i,
        /ACORD\s*25/i,
        /CERTIFICATE\s+HOLDER/i,
        /Motor\s+Truck\s+Cargo/i,
        /Evidence\s+of\s+Insurance/i,
        /AUTOMOBILE\s+LIABILITY/i,
    ]);
    if (coiScore >= 2 || declared === "COI" || declared === "INSURANCE") {
        reasons.push("insurance_acord");
        return {
            documentType: coiScore >= 2 ? "COI" : "INSURANCE",
            confidence: 0.92,
            reasons,
            requiresBoundaryReview: false,
        };
    }

    const agreementScore = score(text, [
        /BROKER\s*[-–—]\s*CARRIER\s+AGREEMENT/i,
        /Best.?s\s+rating\s+of\s+[“"]?B\+/i,
        /Motor\s+Truck\s+Cargo\s+insurance/i,
        /IN\s+WITNESS\s+WHEREOF/i,
        /GREEN\s+LOGISTICS\s+LLC[\s\S]{0,80}MC\s*#?\s*1237784/i,
    ]);
    if (agreementScore >= 2 || declared === "BROKER_CARRIER_AGREEMENT") {
        reasons.push("broker_carrier_agreement");
        return {
            documentType: "BROKER_CARRIER_AGREEMENT",
            confidence: 0.93,
            reasons,
            requiresBoundaryReview: false,
        };
    }

    const profileScore = score(text, [
        /Carrier\s+Profile/i,
        /Dispatch\s+Contact/i,
        /Dispatch\s+E-?mail/i,
        /FED\s+ID/i,
        /Equipment\s+and\s+Quantity/i,
    ]);
    if (profileScore >= 2 || declared === "CARRIER_PROFILE") {
        reasons.push("carrier_profile");
        return { documentType: "CARRIER_PROFILE", confidence: 0.9, reasons, requiresBoundaryReview: false };
    }

    const noaScore = score(text, [
        /Notice\s+of\s+Assignment/i,
        /hereby\s+assign/i,
        /accounts?\s+receivable/i,
        /factoring\s+company/i,
        /assignee/i,
    ]);
    // "factoring" alone on rate con is not NOA
    if (noaScore >= 2 || (declared === "NOA" && !/LOAD\s+CONFIRMATION/i.test(text))) {
        reasons.push("notice_of_assignment");
        return { documentType: "NOA", confidence: 0.88, reasons, requiresBoundaryReview: false };
    }

    const bolScore = score(text, [
        /Bill\s+of\s+Lading/i,
        /SHIPS\s+FROM/i,
        /SHIPS\s+TO/i,
        /BILL\s+OF\s+LADING\s*:/i,
        /ORIGINAL\s+NOT\s+NEGOTIABLE/i,
    ]);
    if (bolScore >= 2 || declared === "BOL") {
        // Guard: never if RC disclaimer present
        if (/rate\s+confirmation\s+not\s+a\s+BOL/i.test(text)) {
            reasons.push("rc_disclaimer_blocks_bol");
            return {
                documentType: "RATE_CONFIRMATION",
                confidence: 0.97,
                reasons,
                requiresBoundaryReview: false,
            };
        }
        reasons.push("bill_of_lading");
        return { documentType: "BOL", confidence: 0.92, reasons, requiresBoundaryReview: false };
    }

    const podScore = score(text, [
        /Proof\s+of\s+Delivery/i,
        /PROOF\s+OF\s+DELIVERY/i,
        /RECEIVER\s*\(CONSIGNEE\)\s*SIGNATURE/i,
        /delivered\s+in\s+good\s+order/i,
    ]);
    if (podScore >= 2 || declared === "POD") {
        reasons.push("proof_of_delivery");
        return { documentType: "POD", confidence: 0.9, reasons, requiresBoundaryReview: false };
    }

    // Declared type fallback with low confidence → review
    if (declared && declared !== "OTHER") {
        reasons.push("declared_type_fallback");
        const mapped = declared === "INSURANCE" ? "INSURANCE" : (declared as DocAiType);
        return {
            documentType: mapped,
            confidence: 0.55,
            reasons,
            requiresBoundaryReview: true,
        };
    }

    // Multi-doc package heuristic
    const multi =
        (/Carrier\s+Profile/i.test(text) && /BROKER\s*[-–—]\s*CARRIER\s+AGREEMENT/i.test(text)) ||
        (isBrokerBmc84OrSurety(text) === false &&
            /Carrier\s+Profile/i.test(text) &&
            /Form\s+W-?9/i.test(text));
    if (multi) {
        reasons.push("multi_document_package");
        return {
            documentType: "UNKNOWN",
            confidence: 0.4,
            reasons,
            requiresBoundaryReview: true,
        };
    }

    return {
        documentType: "UNKNOWN",
        confidence: 0.3,
        reasons: ["insufficient_signals"],
        requiresBoundaryReview: true,
    };
}
