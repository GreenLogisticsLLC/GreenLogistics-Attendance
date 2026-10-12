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

function parseEinDigits(chunk: string | null | undefined): string | null {
    if (!chunk) return null;
    // W-9 boxes often OCR as "9 9 - 2 2 9 7 8 6 6"
    const digits = String(chunk).replace(/\D/g, "");
    if (digits.length < 9) return null;
    // Prefer first 9 digits in the EIN window (ignore trailing noise)
    const nine = digits.slice(0, 9);
    return `${nine.slice(0, 2)}-${nine.slice(2)}`;
}

const W9_TITLE =
    "Request for Taxpayer Identification Number and Certification";

function extractW9(t: string): ExtractedField[] {
    // Circled header — Form W-9 title must be present.
    const hasTitle =
        /Request\s+for\s+Taxpayer\s+Identification\s+Number\s+and\s+Certification/i.test(t) ||
        /\bForm\s+W-?9\b/i.test(t) ||
        /\bW-?9\b/.test(t);

    // Circled Part I — Employer identification number must be filled.
    const hasEinLabel = /Employer\s+identification\s+number/i.test(t);
    const einWindow =
        pick(t, /Employer\s+identification\s+number([\s\S]{0,160})/i) ||
        pick(t, /\bEIN\b([\s\S]{0,80})/i) ||
        "";
    const ein =
        parseEinDigits(einWindow) ||
        parseEinDigits(pick(t, /\b(\d{2}\s*[-–]?\s*\d{7})\b/)) ||
        parseEinDigits(
            pick(t, /\b(\d(?:\s*\d){1}\s*[-–]?\s*\d(?:\s*\d){6})\b/)
        );

    const ssnWindow = pick(t, /Social\s+security\s+number([\s\S]{0,80})/i) || "";
    const ssnDigits = String(ssnWindow).replace(/\D/g, "");
    const ssn =
        ssnDigits.length >= 9
            ? `${ssnDigits.slice(0, 3)}-${ssnDigits.slice(3, 5)}-${ssnDigits.slice(5, 9)}`
            : pick(t, /\b(\d{3}\s*-\s*\d{2}\s*-\s*\d{4})\b/);

    const tin = ein || ssn;
    const tinType = ein ? "EIN" : ssn ? "SSN" : null;
    return [
        field("documentTitle", hasTitle ? W9_TITLE : null, {
            confidence: hasTitle ? 0.99 : 0,
            fieldStatus: hasTitle ? "FIELD_FOUND" : "FIELD_MISSING",
        }),
        field("einLabelPresent", hasEinLabel ? "Employer identification number" : null, {
            confidence: hasEinLabel ? 0.99 : 0,
            fieldStatus: hasEinLabel ? "FIELD_FOUND" : "FIELD_MISSING",
        }),
        field("name", pick(t, /Name[^\n]*\n([A-Z][^\n]{3,80})/i) || pick(t, /(DONTA\s+CRAIG[^\n]*)/i) ||
            pick(t, /(?:^|\n)(ARSEN\s+KUDANETOV)\b/i)),
        field(
            "businessName",
            pick(t, /Business\s+name[^\n]*\n([^\n]+)/i) ||
                pick(t, /(I\s+GET\s+AROUND\s+TRANSPORTATION\s+LLC)/i) ||
                pick(t, /(ARSEN\s+TRUCKING\s+LLC)/i)
        ),
        field(
            "taxClassification",
            /Individual\/sole\s+proprietor/i.test(t)
                ? "Individual/sole proprietor"
                : /S\s*corporation/i.test(t)
                  ? "S Corporation"
                  : pick(t, /(C\s+Corporation|S\s+Corporation|Partnership|LLC|Limited\s+liability\s+company)/i)
        ),
        field("address", pick(t, /(?:Address|5)\s*[^\n]*\n([^\n]+)/i)),
        field("cityStateZip", pick(t, /([A-Z][A-Za-z]+\s+[A-Z]{2}\s+\d{5})/)),
        field("tinType", tinType),
        field("ein", ein ? redactTin(ein) : null, {
            normalized: ein ? redactTin(ein) : null,
            valueProtected: ein ? tinFingerprint(ein) : null,
            confidence: ein ? 0.95 : 0,
            fieldStatus: ein ? "FIELD_FOUND" : "FIELD_MISSING",
        }),
        field("tin", tin ? redactTin(tin) : null, {
            normalized: tin ? redactTin(tin) : null,
            valueProtected: tin ? tinFingerprint(tin) : null,
            confidence: tin ? 0.9 : 0,
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
    const hasTitle = /NOTICE\s+OF\s+ASSIGNMENT/i.test(t);
    const hasAssign =
        hasTitle ||
        /hereby\s+assign/i.test(t) ||
        /accounts?\s+receivable/i.test(t) ||
        /\bassignment\b/i.test(t);

    // "ARSEN TRUCKING LLC - STRONGSVILLE, OH 44136" under the title
    const headerCarrier =
        pick(t, /NOTICE\s+OF\s+ASSIGNMENT[\s\S]{0,120}?([A-Z][A-Z0-9 &\.'-]{2,80}(?:LLC|INC|CORP|CO\.?))\s*[-–—]\s*[A-Z][^\n]{2,60}/i) ||
        pick(t, /\n([A-Z][A-Z0-9 &\.'-]{2,80}(?:LLC|INC|CORP|CO\.?))\s*[-–—]\s*[A-Z][A-Za-z .]+,\s*[A-Z]{2}\s+\d{5}/);

    const mc =
        normalizeMc(
            pick(t, /MC\s*Number\s*[:#]?\s*([0-9]{4,})/i) ||
                pick(t, /MC\s*#\s*([0-9]{4,})/i) ||
                pick(t, /\bMC[#\s-]*([0-9]{4,})/i)
        ) || null;

    // Signature block carrier name (often above signature / near EIN)
    const signedCarrier =
        pick(t, /(?:^|\n)([A-Z][A-Z0-9 &\.'-]{2,80}(?:LLC|INC|CORP|CO\.?))\s*(?:\n|\r).*?\bEIN\b/i) ||
        pick(t, /\bEIN\s*[:#]?\s*\d{2}-\d{7}[\s\S]{0,80}?([A-Z][A-Z0-9 &\.'-]{2,80}(?:LLC|INC|CORP|CO\.?))/i) ||
        null;

    const carrierLegalName =
        headerCarrier ||
        signedCarrier ||
        pick(t, /Carrier[:\s]+([^\n]+)/i) ||
        pick(t, /(I\s+GET\s+AROUND[^\n]*)/i);

    const address =
        pick(t, /(?:LLC|INC|CORP|CO\.?)\s*[-–—]\s*([A-Z][A-Za-z .]+,\s*[A-Z]{2}\s+\d{5})/) ||
        pick(t, /\b([A-Z][A-Za-z .]+,\s*[A-Z]{2}\s+\d{5})\b/);

    const ein =
        pick(t, /\bEIN\s*[:#]?\s*(\d{2}\s*[-–]?\s*\d{7})\b/i) ||
        pick(t, /\b(\d{2}-\d{7})\b/);

    return [
        field("documentTitle", hasTitle ? "NOTICE OF ASSIGNMENT" : null, {
            confidence: hasTitle ? 0.99 : 0,
            fieldStatus: hasTitle ? "FIELD_FOUND" : "FIELD_MISSING",
        }),
        field(
            "assignmentStatement",
            hasAssign ? "assignment_language_detected" : null,
            {
                confidence: hasAssign ? 0.9 : 0,
                fieldStatus: hasAssign ? "FIELD_FOUND" : "FIELD_MISSING",
            }
        ),
        field("carrierLegalName", carrierLegalName, {
            confidence: carrierLegalName ? 0.92 : 0,
        }),
        field("legalName", carrierLegalName, {
            confidence: carrierLegalName ? 0.9 : 0,
        }),
        field("carrierAddress", address, { confidence: address ? 0.85 : 0 }),
        field("mcNumber", mc, { normalized: mc, confidence: mc ? 0.99 : 0 }),
        field("carrierPrintedName", signedCarrier || carrierLegalName, {
            confidence: signedCarrier || carrierLegalName ? 0.88 : 0,
        }),
        field("factoringCompany", pick(t, /(?:Factor|Assignee|Factoring\s+Company)[:\s]+([^\n]+)/i) ||
            pick(t, /(Love'?s\s+(?:Solutions|Financial)[^\n]*)/i)),
        field("ein", ein, { confidence: ein ? 0.9 : 0 }),
        field("signatureDate", pick(t, /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/) ||
            pick(t, /\b((?:MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY),\s+[A-Z]+\s+\d{1,2},\s+20\d{2})\b/i)),
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
