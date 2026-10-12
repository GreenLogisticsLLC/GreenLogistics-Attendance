import { aiGateway } from "../services/ai-gateway.js";
import type { ExtractedField } from "./extract.js";
import { redactTin, tinFingerprint } from "./normalize.js";

/**
 * Vision field extraction for image-only W-9 (and similar).
 * Never returns full TIN in valueText.
 */
export async function extractW9FieldsWithVision(input: {
    imageBase64: string;
    mimeType?: string;
}): Promise<ExtractedField[]> {
    if (!aiGateway.isConfigured()) return [];
    const prompt = `This is an IRS Form W-9 image. Extract JSON only:
{
  "hasW9Title": boolean,
  "name": string|null,
  "businessName": string|null,
  "taxClassification": string|null,
  "address": string|null,
  "cityStateZip": string|null,
  "tinType": "EIN"|"SSN"|null,
  "tinLast4": string|null,
  "signaturePresent": boolean,
  "signatureDate": string|null
}
Set hasW9Title true if the header shows Form W-9 / "Request for Taxpayer Identification Number and Certification".
Focus on Part I Employer identification number (EIN) — if those boxes are blank, tinType and tinLast4 must be null.
If EIN is filled, set tinType to "EIN" and tinLast4 to the last 4 digits only.
Do not return full SSN/EIN — only last 4 digits in tinLast4.`;
    try {
        const res = await aiGateway.visionJson({
            prompt,
            imageBase64: input.imageBase64,
            mimeType: input.mimeType || "image/jpeg",
        });
        const p = res.parsed || {};
        const last4 = p.tinLast4 ? String(p.tinLast4).replace(/\D/g, "").slice(-4) : "";
        const tinDisplay = last4 ? `******${last4}` : null;
        const isEin = String(p.tinType || "").toUpperCase() === "EIN";
        const field = (
            key: string,
            value: string | null,
            conf = 0.85
        ): ExtractedField => ({
            fieldKey: key,
            valueText: value,
            valueNormalized: value,
            confidence: value ? conf : 0,
            page: 1,
            source: "vision",
            method: "vision",
            fieldStatus: value ? "FIELD_FOUND" : "FIELD_MISSING",
        });
        const hasTitle = p.hasW9Title !== false; // vision W-9 images are Form W-9 unless model says otherwise
        return [
            field(
                "documentTitle",
                hasTitle ? "Request for Taxpayer Identification Number and Certification" : null,
                hasTitle ? 0.95 : 0
            ),
            field("name", p.name ? String(p.name) : null),
            field("businessName", p.businessName ? String(p.businessName) : null),
            field("taxClassification", p.taxClassification ? String(p.taxClassification) : null),
            field("address", p.address ? String(p.address) : null),
            field("cityStateZip", p.cityStateZip ? String(p.cityStateZip) : null),
            field("tinType", p.tinType ? String(p.tinType) : null),
            {
                fieldKey: "ein",
                valueText: isEin ? tinDisplay : null,
                valueNormalized: isEin ? tinDisplay : null,
                valueProtected: isEin && last4 ? tinFingerprint(`000000${last4}`) : null,
                confidence: isEin && tinDisplay ? 0.85 : 0,
                page: 1,
                source: "vision",
                method: "vision",
                fieldStatus: isEin && tinDisplay ? "FIELD_FOUND" : "FIELD_MISSING",
            },
            {
                fieldKey: "tin",
                valueText: tinDisplay,
                valueNormalized: tinDisplay,
                valueProtected: last4 ? tinFingerprint(`000000${last4}`) : null,
                confidence: tinDisplay ? 0.8 : 0,
                page: 1,
                source: "vision",
                method: "vision",
                fieldStatus: tinDisplay ? "FIELD_FOUND" : "FIELD_MISSING",
            },
            field("signatureDate", p.signatureDate ? String(p.signatureDate) : null),
        ];
    } catch {
        return [];
    }
}

/**
 * Vision extraction for scanned Notice of Assignment PDFs.
 */
export async function extractNoaFieldsWithVision(input: {
    imageBase64: string;
    mimeType?: string;
}): Promise<ExtractedField[]> {
    if (!aiGateway.isConfigured()) return [];
    const prompt = `This is a carrier Notice of Assignment (factoring) document image. Extract JSON only:
{
  "hasNoticeOfAssignmentTitle": boolean,
  "carrierLegalName": string|null,
  "carrierAddress": string|null,
  "mcNumber": string|null,
  "ein": string|null,
  "factoringCompany": string|null
}
Set hasNoticeOfAssignmentTitle true only if the document clearly says "NOTICE OF ASSIGNMENT".
mcNumber should be digits only (e.g. "1645860").
carrierAddress is the city/state/ZIP line near the carrier name when present.`;
    try {
        const res = await aiGateway.visionJson({
            prompt,
            imageBase64: input.imageBase64,
            mimeType: input.mimeType || "image/png",
        });
        const p = res.parsed || {};
        const field = (
            key: string,
            value: string | null,
            conf = 0.9
        ): ExtractedField => ({
            fieldKey: key,
            valueText: value,
            valueNormalized: value,
            confidence: value ? conf : 0,
            page: 1,
            source: "vision",
            method: "vision",
            fieldStatus: value ? "FIELD_FOUND" : "FIELD_MISSING",
        });
        const hasTitle = Boolean(p.hasNoticeOfAssignmentTitle);
        const mc = p.mcNumber ? String(p.mcNumber).replace(/\D/g, "") : null;
        const name = p.carrierLegalName ? String(p.carrierLegalName).trim() : null;
        const address = p.carrierAddress ? String(p.carrierAddress).trim() : null;
        return [
            field("documentTitle", hasTitle ? "NOTICE OF ASSIGNMENT" : null, hasTitle ? 0.99 : 0),
            field("carrierLegalName", name),
            field("legalName", name),
            field("carrierAddress", address, 0.85),
            field("mcNumber", mc, mc ? 0.95 : 0),
            field("carrierPrintedName", name, name ? 0.85 : 0),
            field("factoringCompany", p.factoringCompany ? String(p.factoringCompany) : null, 0.8),
            field("ein", p.ein ? String(p.ein) : null, 0.8),
            field(
                "assignmentStatement",
                hasTitle ? "assignment_language_detected" : null,
                hasTitle ? 0.9 : 0
            ),
        ];
    } catch {
        return [];
    }
}

void redactTin;
