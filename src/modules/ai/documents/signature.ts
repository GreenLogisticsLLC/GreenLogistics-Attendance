/**
 * Multimodal-aware signature analysis.
 * Heuristics for text/PDF; optional vision override; injectable for tests.
 */

export type SignatureStatus =
    | "PRESENT"
    | "MISSING"
    | "UNCERTAIN"
    | "TYPED_ONLY"
    | "PRINTED_ONLY";

export type SignatureType = "HANDWRITTEN" | "E_SIGN" | "TYPED" | "PRINTED" | "NONE" | "UNKNOWN";

export type SignatureResult = {
    role: string;
    signaturePresent: boolean;
    signatureType: SignatureType;
    confidence: number;
    page: number | null;
    region: string | null;
    status: SignatureStatus;
    method: "text" | "vision" | "heuristic" | "fixture";
    reason: string;
};

export type SignatureScenario =
    | "EMPTY"
    | "HANDWRITTEN"
    | "TYPED_ONLY"
    | "PRINTED_ONLY"
    | "UNCERTAIN"
    | "E_SIGN";

/** Deterministic analyzer used by POD golden tests and text-layer heuristics. */
export function analyzeSignatureScenario(
    scenario: SignatureScenario,
    role = "RECEIVER"
): SignatureResult {
    switch (scenario) {
        case "HANDWRITTEN":
            return {
                role,
                signaturePresent: true,
                signatureType: "HANDWRITTEN",
                confidence: 0.96,
                page: 1,
                region: "final_signature_box",
                status: "PRESENT",
                method: "fixture",
                reason: "Visible handwritten signature mark detected",
            };
        case "E_SIGN":
            return {
                role,
                signaturePresent: true,
                signatureType: "E_SIGN",
                confidence: 0.93,
                page: 1,
                region: "final_signature_box",
                status: "PRESENT",
                method: "fixture",
                reason: "Valid electronic signature appearance",
            };
        case "TYPED_ONLY":
            return {
                role,
                signaturePresent: false,
                signatureType: "TYPED",
                confidence: 0.9,
                page: 1,
                region: "final_signature_box",
                status: "TYPED_ONLY",
                method: "fixture",
                reason: "Typed name only — not a signature mark",
            };
        case "PRINTED_ONLY":
            return {
                role,
                signaturePresent: false,
                signatureType: "PRINTED",
                confidence: 0.9,
                page: 1,
                region: "final_signature_box",
                status: "PRINTED_ONLY",
                method: "fixture",
                reason: "Printed name only — not a signature mark",
            };
        case "UNCERTAIN":
            return {
                role,
                signaturePresent: false,
                signatureType: "UNKNOWN",
                confidence: 0.45,
                page: 1,
                region: "final_signature_box",
                status: "UNCERTAIN",
                method: "fixture",
                reason: "Signature region visually ambiguous",
            };
        case "EMPTY":
        default:
            return {
                role,
                signaturePresent: false,
                signatureType: "NONE",
                confidence: 0.95,
                page: 1,
                region: "final_signature_box",
                status: "MISSING",
                method: "fixture",
                reason: "Empty signature area",
            };
    }
}

/**
 * Text-layer heuristic only — never alone enough to mark POD VALID.
 * Returns UNCERTAIN when a signature box exists without visual confirmation.
 */
export function analyzeSignaturesFromText(input: {
    text: string;
    documentType: string;
}): SignatureResult[] {
    const t = String(input.text || "");
    const type = input.documentType;
    const out: SignatureResult[] = [];

    if (type === "POD" || type === "BOL") {
        const hasReceiverSection =
            /RECEIVER\s*\(CONSIGNEE\)\s*SIGNATURE/i.test(t) ||
            /PRINT\s+NAME\s+SIGNATURE\s+DATE/i.test(t) ||
            /Proof\s+of\s+Delivery/i.test(t);
        const docusign = /DocuSign\s+Envelope/i.test(t);
        if (docusign && /signed/i.test(t)) {
            out.push({
                role: "RECEIVER",
                signaturePresent: true,
                signatureType: "E_SIGN",
                confidence: 0.7,
                page: null,
                region: "document",
                status: "PRESENT",
                method: "text",
                reason: "DocuSign envelope indicators (needs vision confirm for VALID)",
            });
        } else if (hasReceiverSection) {
            out.push({
                role: "RECEIVER",
                signaturePresent: false,
                signatureType: "UNKNOWN",
                confidence: 0.4,
                page: null,
                region: "final_signature_box",
                status: "UNCERTAIN",
                method: "heuristic",
                reason: "Receiver signature section found — vision required to confirm mark",
            });
        } else {
            out.push({
                role: "RECEIVER",
                signaturePresent: false,
                signatureType: "NONE",
                confidence: 0.7,
                page: null,
                region: null,
                status: "MISSING",
                method: "heuristic",
                reason: "No receiver signature section detected in text",
            });
        }
    }

    if (type === "W9") {
        const hasSigLabel = /Signature\s+of\s+U\.?\s*S\.?\s*person/i.test(t);
        out.push({
            role: "TAXPAYER",
            signaturePresent: false,
            signatureType: "UNKNOWN",
            confidence: 0.4,
            page: 1,
            region: "part_ii",
            status: hasSigLabel ? "UNCERTAIN" : "MISSING",
            method: "heuristic",
            reason: hasSigLabel
                ? "W-9 certification signature area present — vision required"
                : "W-9 signature area not detected",
        });
    }

    if (type === "BROKER_CARRIER_AGREEMENT") {
        out.push({
            role: "BROKER",
            signaturePresent: /SPARTAK|Authorized\s+Signature/i.test(t),
            signatureType: "UNKNOWN",
            confidence: 0.5,
            page: null,
            region: "witness_block",
            status: "UNCERTAIN",
            method: "heuristic",
            reason: "Agreement signature block — vision recommended",
        });
        out.push({
            role: "CARRIER",
            signaturePresent: false,
            signatureType: "UNKNOWN",
            confidence: 0.5,
            page: null,
            region: "witness_block",
            status: "UNCERTAIN",
            method: "heuristic",
            reason: "Carrier signature requires visual confirmation",
        });
    }

    if (type === "RATE_CONFIRMATION") {
        out.push({
            role: "CARRIER",
            signaturePresent: false,
            signatureType: "UNKNOWN",
            confidence: 0.4,
            page: 1,
            region: "carrier_signature",
            status: /CARRIER\s+SIGNATURE/i.test(t) ? "UNCERTAIN" : "MISSING",
            method: "heuristic",
            reason: "Carrier signature line present — vision required for VALID signed RC",
        });
    }

    return out;
}

export function podOverallFromSignature(sig: SignatureResult): {
    overallHint: "VALID_SIG" | "UNSIGNED" | "REVIEW_REQUIRED";
    neverValid: boolean;
} {
    if (sig.status === "PRESENT" && sig.signaturePresent && sig.confidence >= 0.85) {
        return { overallHint: "VALID_SIG", neverValid: false };
    }
    if (sig.status === "MISSING" || sig.status === "TYPED_ONLY" || sig.status === "PRINTED_ONLY") {
        return { overallHint: "UNSIGNED", neverValid: true };
    }
    return { overallHint: "REVIEW_REQUIRED", neverValid: true };
}
