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
        return [
            field("name", p.name ? String(p.name) : null),
            field("businessName", p.businessName ? String(p.businessName) : null),
            field("taxClassification", p.taxClassification ? String(p.taxClassification) : null),
            field("address", p.address ? String(p.address) : null),
            field("cityStateZip", p.cityStateZip ? String(p.cityStateZip) : null),
            field("tinType", p.tinType ? String(p.tinType) : null),
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

void redactTin;
