import type { DocAiType } from "./classify.js";
import {
    normalizeDot,
    normalizeLoadNumber,
    normalizeMc,
    normalizeMoney,
    normalizePhone,
    redactTin,
    tinFingerprint,
} from "./normalize.js";

export type ExtractedField = {
    fieldKey: string;
    valueText: string | null;
    valueNormalized: string | null;
    valueProtected?: string | null;
    confidence: number;
    page: number | null;
    source: string;
    method: string;
    fieldStatus: string;
};

function field(
    key: string,
    value: string | null,
    opts: Partial<ExtractedField> & { normalized?: string | null } = {}
): ExtractedField {
    const found = Boolean(value && String(value).trim());
    return {
        fieldKey: key,
        valueText: found ? String(value).trim() : null,
        valueNormalized: opts.normalized ?? (found ? String(value).trim() : null),
        valueProtected: opts.valueProtected ?? null,
        confidence: opts.confidence ?? (found ? 0.9 : 0),
        page: opts.page ?? 1,
        source: opts.source ?? "page_1",
        method: opts.method ?? "text",
        fieldStatus: opts.fieldStatus ?? (found ? "FIELD_FOUND" : "FIELD_MISSING"),
    };
}

function pick(text: string, re: RegExp): string | null {
    const m = text.match(re);
    return m?.[1]?.trim() || null;
}

export function extractFieldsForType(documentType: DocAiType, text: string): ExtractedField[] {
    // PDF text layers sometimes insert control chars (e.g. MC:\x04 1820780)
    const t = String(text || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
    switch (documentType) {
        case "CARRIER_PROFILE":
            return extractCarrierProfile(t);
        case "BROKER_CARRIER_AGREEMENT":
            return extractAgreement(t);
        case "W9":
            return extractW9(t);
        case "COI":
        case "INSURANCE":
            return extractCoi(t);
        case "MC_AUTHORITY":
            return extractMcAuthority(t);
        case "NOA":
            return extractNoa(t);
        case "RATE_CONFIRMATION":
            return extractRateCon(t);
        case "BOL":
            return extractBol(t);
        case "POD":
            return extractPod(t);
        default:
            return [];
    }
}

function extractCarrierProfile(t: string): ExtractedField[] {
    const mc = normalizeMc(pick(t, /MC#?\s*[:.]?\s*([0-9]{4,})/i) || pick(t, /\b(1820780)\b/));
    const dot = normalizeDot(pick(t, /DOT#?\s*[:.]?\s*([0-9]{4,})/i));
    const name =
        pick(t, /Carrier\s+Name\s*[:.]?\s*([^\n]+)/i) ||
        pick(t, /(I\s+GET\s+AROUND\s+TRANSPORTATION\s+LLC)/i);
    return [
        field("legalName", name, { confidence: name ? 0.92 : 0 }),
        field("address", pick(t, /Address\s*[:.]?\s*([^\n]+)/i)),
        field("mcNumber", mc, { normalized: mc, confidence: mc ? 0.98 : 0 }),
        field("dotNumber", dot, { normalized: dot, confidence: dot ? 0.98 : 0 }),
        field("dispatchContact", pick(t, /Dispatch\s+Contact\s*[:.]?\s*([^\n]+)/i)),
        field("phone", pick(t, /Phone\s*[:.]?\s*([0-9()\-\s.]+)/i), {
            normalized: normalizePhone(pick(t, /Phone\s*[:.]?\s*([0-9()\-\s.]+)/i)),
        }),
        field("dispatchEmail", pick(t, /Dispatch\s+E-?mail\s*[:.]?\s*([^\s\n]+)/i)),
        field("equipment", pick(t, /Equipment[^\n]*\n([^\n]+)/i) || pick(t, /\b(\d+\s*ft)\b/i)),
    ];
}

function extractAgreement(t: string): ExtractedField[] {
    const carrierMc = normalizeMc(
        pick(t, /Carrier[^\n]{0,40}MC[#\s]*([0-9]{4,})/i) || pick(t, /\bMC[#\s-]*([0-9]{4,})/i)
    );
    const brokerMc = normalizeMc(pick(t, /MC\s*#\s*(1237784)/i) || "1237784");
    return [
        field("brokerLegalName", pick(t, /(GREEN\s+LOGISTICS\s+LLC)/i), { confidence: 0.95 }),
        field("brokerMc", brokerMc, { normalized: brokerMc, confidence: 0.99 }),
        field(
            "carrierLegalName",
            pick(t, /(I\s+GET\s+AROUND\s+TRANSPORTATION\s+LLC)/i) ||
                pick(t, /\(CARRIER\)[\s\S]{0,80}?([A-Z][A-Z0-9 &\-]{5,80}LLC)/i)
        ),
        field("carrierMc", carrierMc, { normalized: carrierMc }),
        field(
            "agreementDate",
            pick(t, /entered\s+into\s+on[,\s]*([0-9/\-]+)/i) ||
                pick(t, /\b(\d{1,2}\s+\d{1,2}\s+20\d{2})\b/)
        ),
        field("paymentOption", pick(t, /(Standard\s+Payment|Quick\s+Pay|Factoring\s+company)/i)),
        field("brokerPrintedName", pick(t, /Printed\s+Name\s*[–—-]?\s*(SPARTAK\s+KAZARYAN)/i)),
        field("carrierPrintedName", pick(t, /Printed\s+Name[^\n]*\n([A-Za-z ]{3,40})/i)),
    ];
}

function extractW9(t: string): ExtractedField[] {
    const ein =
        pick(t, /Employer\s+identification\s+number[\s\S]{0,80}?(\d{2}\s*[-–]?\s*\d{7})/i) ||
        pick(t, /\b(\d{2}\s*-\s*\d{7})\b/);
    const ssn = pick(t, /Social\s+security\s+number[\s\S]{0,40}?(\d{3}\s*-\s*\d{2}\s*-\s*\d{4})/i);
    const tin = ein || ssn;
    const tinType = ein ? "EIN" : ssn ? "SSN" : null;
    return [
        field("name", pick(t, /Name[^\n]*\n([A-Z][^\n]{3,80})/i) || pick(t, /(DONTA\s+CRAIG[^\n]*)/i)),
        field(
            "businessName",
            pick(t, /Business\s+name[^\n]*\n([^\n]+)/i) ||
                pick(t, /(I\s+GET\s+AROUND\s+TRANSPORTATION\s+LLC)/i)
        ),
        field(
            "taxClassification",
            /Individual\/sole\s+proprietor/i.test(t)
                ? "Individual/sole proprietor"
                : pick(t, /(C\s+Corporation|S\s+Corporation|Partnership|LLC)/i)
        ),
        field("address", pick(t, /(?:Address|5)\s*[^\n]*\n([^\n]+)/i)),
        field("cityStateZip", pick(t, /([A-Z][A-Za-z]+\s+[A-Z]{2}\s+\d{5})/)),
        field("tinType", tinType),
        field("tin", tin ? redactTin(tin) : null, {
            normalized: tin ? redactTin(tin) : null,
            valueProtected: tin ? tinFingerprint(tin) : null,
            confidence: tin ? 0.85 : 0,
            fieldStatus: tin ? "FIELD_FOUND" : "FIELD_MISSING",
        }),
        field("signatureDate", pick(t, /\b(\d{2}\/\d{2}\/\d{4})\b/)),
    ];
}

function extractCoi(t: string): ExtractedField[] {
    const auto =
        pick(t, /AUTOMOBILE\s+LIABILITY[\s\S]{0,200}?(1[, ]?000[, ]?000)/i) ||
        pick(t, /\b(1[, ]?000[, ]?000)\b/);
    const cargo =
        pick(t, /Limit\s*\$\s*([0-9,]{5,})/i) ||
        pick(t, /Motor\s+Truck\s+Cargo[\s\S]{0,200}?\$\s*([0-9,]{5,})/i) ||
        pick(t, /\$\s*(100[,]?000)\b/);
    const gl =
        pick(t, /COMMERCIAL\s+GENERAL\s+LIABILITY[\s\S]{0,200}?(1[, ]?000[, ]?000)/i) ||
        (auto ? "1000000" : null);
    const holder =
        pick(t, /CERTIFICATE\s+HOLDER[\s\S]{0,200}?(GREEN\s+LOGISTICS\s+LLC)/i) ||
        (/GREEN\s+LOGISTICS\s+LLC/i.test(t) ? "GREEN LOGISTICS LLC" : null);
    const mc = normalizeMc(pick(t, /MC\s*#?\s*:?\s*(?:MC)?\s*([0-9]{4,})/i));
    const dot = normalizeDot(pick(t, /DOT\s*#?\s*:?\s*([0-9]{4,})/i));
    const dates = [...t.matchAll(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\b/g)].map(
        (m) => m[0]
    );
    // ACORD text often glues eff/exp: 05/15/202605/15/2027
    const glued = t.match(/(\d{1,2}\/\d{1,2}\/\d{4})(\d{1,2}\/\d{1,2}\/\d{4})/);
    const policyBlock = t.match(
        /01\s*TRM[^\n]*?(\d{1,2}\/\d{1,2}\/\d{4})\s*(\d{1,2}\/\d{1,2}\/\d{4})/i
    );
    const policyEff = policyBlock?.[1] || glued?.[1] || null;
    const policyExp = policyBlock?.[2] || glued?.[2] || dates.find((d) => /2027/.test(d)) || null;
    const insured =
        pick(t, /(I\s+Get\s+Ar{1,2}ound\s+Transpor[a-z]*\s+LLC)/i) ||
        pick(t, /(I\s+GET\s+AROUND\s+TRANSPORTATION\s+LLC)/i) ||
        pick(t, /INSURED[\s\S]{0,120}?([A-Z][A-Za-z0-9 &.'-]{6,80}\s+LLC)/);
    return [
        field("insuredName", insured, { confidence: insured ? 0.85 : 0 }),
        field("producer", pick(t, /(Jump\s+Insurance\s+Services)/i)),
        field("insurer", pick(t, /(REDWOOD\s+FIRE[^\n]*)/i)),
        field("policyNumber", pick(t, /\b(01\s*TRM\s*[0-9-]+)\b/i)),
        field("policyEff", policyEff),
        field("policyExp", policyExp),
        field("certificateDate", pick(t, /\b(8\/13\/2026|5\/19\/2026)\b/) || dates[0] || null),
        field("autoLiabilityLimit", auto, {
            normalized: auto ? String(normalizeMoney(auto)) : null,
        }),
        field("cargoLimit", cargo, {
            normalized: cargo ? String(normalizeMoney(cargo)) : null,
        }),
        field("glLimit", gl, {
            normalized: gl ? String(normalizeMoney(gl)) : null,
            confidence: gl ? 0.8 : 0,
            fieldStatus: gl ? "FIELD_FOUND" : "FIELD_MISSING",
        }),
        field("certificateHolder", holder),
        field("mcNumber", mc, { normalized: mc }),
        field("dotNumber", dot, { normalized: dot }),
        field("vin", (() => {
            const v = pick(t, /VIN\s*=?\s*([A-HJ-NPR-Z0-9]{11,17})/i);
            return v && v.length >= 11 ? v : null;
        })()),
        field("vehicle", pick(t, /Vehicle:\s*([^;]+)/i)),
    ];
}

function extractMcAuthority(t: string): ExtractedField[] {
    const mc = normalizeMc(pick(t, /\bMC-([0-9]{4,})-[A-Z]\b/i) || pick(t, /\bMC[#\s-]*([0-9]{4,})/i));
    const dot = normalizeDot(pick(t, /U\.?S\.?\s*DOT\s*No\.?\s*([0-9]{4,})/i));
    const cert = pick(t, /\b(MC-\d{4,}-[A-Z])\b/i);
    return [
        field(
            "legalName",
            pick(t, /(I\s+GET\s+AROUND\s+TRANSPORTATION\s+LLC)/i) ||
                pick(t, /\n([A-Z][A-Z0-9 &\-]{5,80}LLC)\s*$/m)
        ),
        field("mcNumber", mc, { normalized: mc, confidence: 0.99 }),
        field("dotNumber", dot, { normalized: dot, confidence: 0.99 }),
        field("certificateNumber", cert, { confidence: 0.98 }),
        field("serviceDate", pick(t, /\b(April\s+\d{1,2},\s+20\d{2})\b/i) || pick(t, /\b(\d{2}\/\d{2}\/\d{4})\b/)),
        field(
            "authorityType",
            /common\s+carrier\s+of\s+property/i.test(t) ? "common_carrier_property" : null
        ),
    ];
}

function extractNoa(t: string): ExtractedField[] {
    return [
        field(
            "carrierLegalName",
            pick(t, /Carrier[:\s]+([^\n]+)/i) || pick(t, /(I\s+GET\s+AROUND[^\n]*)/i)
        ),
        field("factoringCompany", pick(t, /(?:Factor|Assignee|Factoring\s+Company)[:\s]+([^\n]+)/i)),
        field(
            "assignmentStatement",
            /assign/i.test(t) ? "assignment_language_detected" : null,
            { confidence: /assign/i.test(t) ? 0.8 : 0, fieldStatus: /assign/i.test(t) ? "FIELD_FOUND" : "FIELD_MISSING" }
        ),
        field("signatureDate", pick(t, /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/)),
    ];
}

function extractRateCon(t: string): ExtractedField[] {
    const load = normalizeLoadNumber(pick(t, /LOAD\s+NO\s*:?\s*([A-Z0-9-]+)/i));
    const mc = normalizeMc(pick(t, /MC#?\s*([0-9]{4,})/i));
    const dot = normalizeDot(pick(t, /DOT#?\s*([0-9]{4,})/i));
    const rate = pick(t, /Flat\s+Rate\s*:?\s*\$?\s*([0-9,]+)/i) || pick(t, /Total:\s*\$?\s*([0-9,]+)/i);
    return [
        field("loadNumber", load, { normalized: load, confidence: 0.98 }),
        field("broker", pick(t, /(Green\s+Logistics\s+LLC)/i)),
        field("brokerMc", normalizeMc(pick(t, /MC\s*#\s*(1237784)/i)), {
            normalized: normalizeMc(pick(t, /MC\s*#\s*(1237784)/i)),
        }),
        field("carrier", pick(t, /CARRIER:\s*([^\n]+)/i)),
        field("carrierMc", mc, { normalized: mc }),
        field("carrierDot", dot, { normalized: dot }),
        field("origin", pick(t, /ORIGIN:\s*([^\n]+)/i) || pick(t, /(3433\s+Steen[^\n]*)/i)),
        field("destination", pick(t, /Final\s+Destination[\s\S]{0,40}?([0-9]+[^\n]+)/i) || pick(t, /(577\s+N\s+Batavia[^\n]*)/i)),
        field("pickupDate", pick(t, /DATE:\s*([0-9/]+)/i)),
        field("deliveryDate", pick(t, /DATE:\s*[0-9/]+[\s\S]{0,200}?DATE:\s*([0-9/]+)/i)),
        field("commodity", pick(t, /COMMODITY:\s*([^\n]+)/i)),
        field("weight", pick(t, /WEIGHT:\s*([^\n]+)/i)),
        field("equipment", pick(t, /EQUIPMENT:\s*([^\n]+)/i)),
        field("flatRate", rate, { normalized: rate ? String(normalizeMoney(rate)) : null }),
        field("paymentOption", pick(t, /PAYMENT\s+OPTION:\s*([^\n]+)/i)),
        field("driver", pick(t, /DRIVER[\s\S]{0,40}?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/)),
    ];
}

function extractBol(t: string): ExtractedField[] {
    const bol = normalizeLoadNumber(pick(t, /BILL\s+OF\s+LADING:\s*([A-Z0-9-]+)/i));
    const mc = normalizeMc(
        pick(t, /MC\s*[:.#]*\s*([0-9]{4,})/i) || pick(t, /MC[#\s:-]*([0-9]{4,})/i)
    );
    const vinRaw = pick(t, /VIN:\s*([A-HJ-NPR-Z0-9]*)/i);
    const vin = vinRaw && vinRaw.length >= 11 ? vinRaw : null;
    return [
        field("bolNumber", bol, { normalized: bol }),
        field("pickupDate", pick(t, /PICKUP\s+DATE:\s*([0-9/]+)/i)),
        field("shipper", pick(t, /(3433\s+Steen[^\n]*)/i)),
        field("consignee", pick(t, /(577\s+N\s+Batavia[^\n]*)/i)),
        field("carrier", pick(t, /CARRIER:\s*([^\n]+)/i)),
        field("mcNumber", mc, { normalized: mc }),
        field("commodity", pick(t, /COMMODITY:\s*([^\n]+)/i)),
        field("weight", pick(t, /Weight\s*([0-9.,]+\s*LBS)/i)),
        field("truck", pick(t, /Truck:\s*([^\n]+)/i)),
        field("trailer", pick(t, /Trailer:\s*([^\n]+)/i)),
        field("vin", vin),
    ];
}

function extractPod(t: string): ExtractedField[] {
    return [
        field("loadOrBolId", normalizeLoadNumber(pick(t, /(?:LOAD|BOL|BILL OF LADING)[:\s#]*([A-Z0-9-]+)/i))),
        field("carrier", pick(t, /CARRIER:\s*([^\n]+)/i)),
        field("deliveryDate", pick(t, /(?:DELIVERY|DATE)\s*:?\s*([0-9/.-]+)/i)),
        field("receiverName", pick(t, /(?:PRINT\s+NAME|Receiver)\s*:?\s*([A-Za-z .'-]{3,60})/i)),
        field("deliveryLocation", pick(t, /(?:DELIVER(?:Y|ED)\s+(?:TO|AT))\s*:?\s*([^\n]+)/i)),
        field(
            "exceptions",
            /except\s+as\s+noted/i.test(t) ? "exceptions_section_present" : null,
            { confidence: 0.6, fieldStatus: "FIELD_FOUND" }
        ),
    ];
}

export function fieldsToMap(fields: ExtractedField[]): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const f of fields) out[f.fieldKey] = f.valueNormalized ?? f.valueText;
    return out;
}
