import test from "node:test";
import assert from "node:assert/strict";
import {
    classifyDocumentText,
    isBrokerBmc84OrSurety,
    isFmcsaMcAuthority,
} from "./documents/classify.js";
import { normalizeDot, normalizeMc, redactTin } from "./documents/normalize.js";
import {
    checkCertificateHolder,
    checkMoneyMin,
    evaluateInsuranceRules,
    GL_RULES,
} from "./documents/rules.js";
import { extractFieldsForType } from "./documents/extract.js";
import {
    analyzeSignatureScenario,
    podOverallFromSignature,
} from "./documents/signature.js";
import { validateDocument } from "./documents/validate.js";

const FMCSA_MC = `
Federal Motor Carrier Safety Administration
U.S. Department of Transportation
CERTIFICATE
MC-1820780-C
CERES, CA
U.S. DOT No. 4575864
I GET AROUND TRANSPORTATION LLC
This Certificate is evidence of the carrier's authority to engage in transportation as a common carrier of property
`;

const BMC84 = `
FORM BMC-84
Bond Number: GSC0602680
GREEN LOGISTICS LLC
91 N YORK RD APT 500-40 Willow Grove Pennsylvania 19090
THE GRAY INSURANCE COMPANY
Power of Attorney
`;

const RATE_CON = `
LOAD CONFIRMATION AND PAYMENT AGREEMENT
MC # 1237784
LOAD NO:75246
CARRIER: I GET AROUND TRANSPORTATION LLC
MC# 1820780
DOT#4575864
Flat Rate: $3000
This is a rate confirmation not a BOL. If you use this as BOL you may not be paid.
`;

const BOL = `
Bill of Lading
BILL OF LADING: 75246
SHIPS FROM
SHIPS TO
CARRIER: I GET AROUND TRANSPORTATION LLC
MC:# 1820780
COMMODITY: L35 FT W65 Inch
PICKUP DATE: 8/13/2026
ORIGINAL NOT NEGOTIABLE
`;

test("normalize MC and DOT digits-only", () => {
    assert.equal(normalizeMc("MC-1820780"), "1820780");
    assert.equal(normalizeMc("MC 1820780"), "1820780");
    assert.equal(normalizeMc("mc1820780"), "1820780");
    assert.equal(normalizeDot("DOT4575864"), "4575864");
    assert.equal(normalizeDot("DOT-4575864"), "4575864");
});

test("TIN redaction never returns full value", () => {
    assert.equal(redactTin("42-2248853"), "******8853");
    assert.ok(!String(redactTin("42-2248853")).includes("422248853"));
});

test("BMC-84 / Gray surety is NOT carrier MC_AUTHORITY", () => {
    assert.equal(isBrokerBmc84OrSurety(BMC84), true);
    assert.equal(isFmcsaMcAuthority(BMC84), false);
    const c = classifyDocumentText({ text: BMC84, fileName: "bmc84.pdf" });
    assert.equal(c.documentType, "UNSUPPORTED");
});

test("Granted MC Letter classifies as MC_AUTHORITY", () => {
    assert.equal(isFmcsaMcAuthority(FMCSA_MC), true);
    const c = classifyDocumentText({ text: FMCSA_MC, fileName: "GRANTED MC LETTER 1820780.pdf" });
    assert.equal(c.documentType, "MC_AUTHORITY");
    const fields = extractFieldsForType("MC_AUTHORITY", FMCSA_MC);
    const mc = fields.find((f) => f.fieldKey === "mcNumber");
    assert.equal(mc?.valueNormalized, "1820780");
});

test("Rate Confirmation is never classified as BOL", () => {
    const c = classifyDocumentText({ text: RATE_CON, fileName: "75246.pdf" });
    assert.equal(c.documentType, "RATE_CONFIRMATION");
    assert.notEqual(c.documentType, "BOL");
});

test("BOL classifies as BOL when not RC", () => {
    const c = classifyDocumentText({ text: BOL, fileName: "BOL 75246.pdf" });
    assert.equal(c.documentType, "BOL");
});

test("insurance business rules: cargo/auto minima and holder", () => {
    const below = checkMoneyMin("BR-INS-CARGO", "Cargo", 50000, GL_RULES.CARGO_MIN);
    assert.equal(below.status, "BELOW_REQUIREMENT");
    const ok = checkMoneyMin("BR-INS-AUTO", "Auto", 1000000, GL_RULES.AUTO_LIABILITY_MIN);
    assert.equal(ok.status, "PASS");
    const holder = checkCertificateHolder("GREEN LOGISTICS LLC");
    assert.equal(holder.ok, true);
    const badHolder = checkCertificateHolder("SOME OTHER BROKER LLC");
    assert.equal(badHolder.ok, false);
    const rules = evaluateInsuranceRules({
        autoLiabilityLimit: 1000000,
        cargoLimit: 100000,
        glLimit: 1000000,
        certificateHolder: "GREEN LOGISTICS LLC",
        policyExp: "05/15/2099",
    });
    assert.ok(rules.every((r) => r.ok || r.status === "SKIPPED"));
});

test("POD golden A: empty signature never VALID", () => {
    const sig = analyzeSignatureScenario("EMPTY");
    const hint = podOverallFromSignature(sig);
    assert.equal(hint.neverValid, true);
    assert.equal(hint.overallHint, "UNSIGNED");
    const v = validateDocument({
        documentType: "POD",
        classifyConfidence: 0.95,
        fields: [
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
        ],
        signatures: [sig],
    });
    assert.notEqual(v.overallStatus, "VALID");
    assert.ok(v.overallStatus === "UNSIGNED" || v.overallStatus === "REVIEW_REQUIRED");
    assert.equal(v.trafficLight, "RED");
});

test("POD golden B: handwritten signature PRESENT", () => {
    const sig = analyzeSignatureScenario("HANDWRITTEN");
    assert.equal(sig.status, "PRESENT");
    assert.equal(sig.signaturePresent, true);
    const hint = podOverallFromSignature(sig);
    assert.equal(hint.overallHint, "VALID_SIG");
});

test("POD golden C: typed-only never VALID", () => {
    const sig = analyzeSignatureScenario("TYPED_ONLY");
    const hint = podOverallFromSignature(sig);
    assert.equal(sig.status, "TYPED_ONLY");
    assert.equal(hint.neverValid, true);
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
        ],
        signatures: [sig],
    });
    assert.notEqual(v.overallStatus, "VALID");
});

test("POD golden D: uncertain → REVIEW_REQUIRED", () => {
    const sig = analyzeSignatureScenario("UNCERTAIN");
    const hint = podOverallFromSignature(sig);
    assert.equal(hint.overallHint, "REVIEW_REQUIRED");
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
        ],
        signatures: [sig],
    });
    assert.equal(v.overallStatus, "REVIEW_REQUIRED");
    assert.notEqual(v.overallStatus, "VALID");
});

test("MC mismatch is CRITICAL_MISMATCH", () => {
    const v = validateDocument({
        documentType: "MC_AUTHORITY",
        classifyConfidence: 0.99,
        fields: extractFieldsForType("MC_AUTHORITY", FMCSA_MC),
        greenOs: { legalName: "OTHER CARRIER LLC", mcNumber: "1234567", dotNumber: "9999999" },
    });
    assert.equal(v.overallStatus, "MISMATCH");
    assert.ok(v.matches.some((m) => m.status === "CRITICAL_MISMATCH"));
});

test("factoring word on rate con is not NOA", () => {
    const c = classifyDocumentText({
        text: RATE_CON + "\nPAYMENT OPTION: FACTORING\n",
        declaredType: null,
    });
    assert.equal(c.documentType, "RATE_CONFIRMATION");
});

test("W9 extraction redacts TIN", () => {
    const text = `
Form W-9 Request for Taxpayer Identification Number
Name DONTA CRAIG JERMON GREEN
Business name I GET AROUND TRANSPORTATION LLC
Individual/sole proprietor
Employer identification number 42 - 2248853
Part II Certification
05/26/2026
`;
    const fields = extractFieldsForType("W9", text);
    const tin = fields.find((f) => f.fieldKey === "tin");
    assert.ok(tin?.valueText?.startsWith("******"));
    assert.ok(!tin?.valueText?.includes("422248853"));
});
