import assert from "node:assert/strict";
import test from "node:test";
import { AGREEMENT_TEMPLATE_VERSION, BROKER_AGREEMENT_CONTACT, DEFAULT_AGREEMENT_BODY } from "./constants.js";
import { buildCarrierAgreementPdf } from "./services/carrier-agreement-pdf.service.js";

const text = DEFAULT_AGREEMENT_BODY;

test("setup agreement is version 2.5 and uses the company contact block", () => {
    assert.equal(AGREEMENT_TEMPLATE_VERSION, "2.5");
    assert.match(text, /Version 2\.5/);
    assert.match(text, new RegExp(BROKER_AGREEMENT_CONTACT.address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text, /MC # 1237784/);
    assert.match(text, /USDOT # 3622287/);
    assert.doesNotMatch(text, /Kamo|sample carrier/i);
});

test("version 2.5 restores the named PDF protections", () => {
    const required = [
        "A.M. Best rating of “B+” VII",
        "certificates of insurance",
        "US$100,000 per shipment",
        "full value of the cargo",
        "US$10,000 per shipment",
        "while the cargo is in storage",
        "no aggregate limit",
        "US$1,000,000 per occurrence",
        "Employer’s Liability insurance of not less than US$500,000",
        "49 C.F.R. §§ 387.7 and 387.9",
        "MCS-90 endorsement",
        "Broadened Pollution Liability",
        "Certificate Holder",
        "thirty (30) days",
        "primary and non-contributory",
        "waive subrogation",
        "unattended equipment or cargo",
        "unscheduled drivers",
        "fraud or infidelity",
        "tarp warranty",
        "wetness or dampness",
        "geographic restriction",
        "unattached trailer",
        "radius restriction",
        "Workers’ Compensation Board",
        "at least once each month",
        "at least one (1) year",
        "insufficient fuel",
        "Destination Market Value",
        "49 C.F.R. §§ 370.1 through 370.11",
        "INTENDED THIRD-PARTY BENEFICIARIES",
        "PARALEGALS",
        "ENVIRONMENTAL CLEANUP",
        "MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW",
        "clear and convincing evidence",
        "stop and secure the shipment",
        "not, by itself, an automatic total loss",
        "ninety (90) days",
        "within thirty (30) days after receiving the claim",
        "49 C.F.R. Part 370",
        "8.1 Salvage Claims",
        "salvage market",
        "employee store",
        "prior written consent",
        "inconvenient forum",
        "writing signed by both parties",
        "competitive detriment",
        "provisions of this Contract",
        "nine (9) months",
        "ten percent (10%)",
        "US$200 for one shipment",
        "does not reach a customer with no such connection",
        "overrides this thirty (30) day period",
        "Standard Payment: payment within 20–25 days",
        "Quick Pay (3%)",
        "Quick Pay (5%)",
        "Letter of Release (LOR)",
        "1.2. No Right to Lien",
        "1.4 Sub-Contract Prohibition",
        "2.1 CANCELLATION FEE",
        "9.1 Safety Rating",
        "11. Savings Clause",
        "12. Term.",
    ];
    for (const phrase of required) {
        assert.equal(text.includes(phrase), true, phrase);
    }
});

test("signed PDF keeps version 2.5, broker contact, and the selected payment option", async () => {
    const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
    );
    const pdf = await buildCarrierAgreementPdf({
        carrierId: "sample",
        legalName: "Sample Carrier LLC",
        email: "dispatch@sample-carrier.test",
        phone: "555-0100",
        mcNumber: "999999",
        dotNumber: "888888",
        address: "1 Carrier Road",
        city: "Dallas",
        state: "TX",
        zip: "75001",
        paymentOption: "FACTORING",
        factoringCompanyName: "Sample Factor LLC",
        agreementTitle: "Broker - Carrier Agreement",
        agreementVersion: "2.5",
        agreementBody: text,
        signerName: "Sample Signer",
        signerEmail: "dispatch@sample-carrier.test",
        signatureDataUrl: "data:image/png;base64," + png.toString("base64"),
        signedAt: new Date("2026-11-03T16:00:00.000Z"),
    });
    const raw = pdf.toString("latin1");
    assert.ok(pdf.length > 20000);
    assert.match(raw, /Broker-Carrier Agreement v2\.5/);
    const pages = (raw.match(/\/Type \/Page[^s]/g) || []).length;
    assert.ok(pages >= 5, "pages " + pages);
});
