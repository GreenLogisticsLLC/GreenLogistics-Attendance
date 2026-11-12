import assert from "node:assert/strict";
import test from "node:test";
import {
    brokerUsesSpartakSignature,
    buildCustomerAgreementPdf,
} from "./customer-agreement-pdf.js";
import { CUSTOMER_AGREEMENT_TYPES } from "./customer-agreement.js";
import { customerAgreementTerms } from "./customer-agreement-content.js";

test("only Spartak gets the stored handwritten customer-agreement signature image", () => {
    assert.equal(brokerUsesSpartakSignature("Spartak Kazaryan"), true);
    assert.equal(brokerUsesSpartakSignature("spartak kazaryan"), true);
    assert.equal(brokerUsesSpartakSignature("Logan Harris"), false);
    assert.equal(brokerUsesSpartakSignature("Lia Torres"), false);
    assert.equal(brokerUsesSpartakSignature(""), false);
});

test("builds a fillable-ready customer agreement PDF with broker autofill", async () => {
    const pdf = await buildCustomerAgreementPdf({
        agreementType: CUSTOMER_AGREEMENT_TYPES.USHIP_ONETIME,
        companyName: "Acme Shipping",
        brokerName: "Lia Torres",
        brokerTitle: "Broker",
        sentAt: new Date("2026-11-10T20:00:00Z"),
        fields: {
            fullLegalName: "Alex Customer",
            companyName: "Acme Shipping",
            email: "alex@example.com",
        },
        timezone: "America/Los_Angeles",
    });
    assert.ok(pdf.length > 1200);
    assert.equal(pdf.subarray(0, 4).toString("utf8"), "%PDF");
});

test("Logan Harris agreement does not embed Spartak signature bytes", async () => {
    const logan = await buildCustomerAgreementPdf({
        agreementType: CUSTOMER_AGREEMENT_TYPES.USHIP_ONETIME,
        companyName: "Acme Shipping",
        brokerName: "Logan Harris",
        brokerTitle: "Broker",
        sentAt: new Date("2026-11-12T12:00:00Z"),
        fields: { fullLegalName: "Alex Customer", companyName: "Acme Shipping" },
        timezone: "America/Los_Angeles",
    });
    const spartak = await buildCustomerAgreementPdf({
        agreementType: CUSTOMER_AGREEMENT_TYPES.USHIP_ONETIME,
        companyName: "Acme Shipping",
        brokerName: "Spartak Kazaryan",
        brokerTitle: "Broker",
        sentAt: new Date("2026-11-12T12:00:00Z"),
        fields: { fullLegalName: "Alex Customer", companyName: "Acme Shipping" },
        timezone: "America/Los_Angeles",
    });
    assert.equal(logan.subarray(0, 4).toString("utf8"), "%PDF");
    assert.equal(spartak.subarray(0, 4).toString("utf8"), "%PDF");
    // Handwritten PNG makes Spartak's PDF larger than name-only signature for Logan.
    assert.ok(spartak.length > logan.length);
});

test("Long Time PDF is larger because it embeds the full master clauses", async () => {
    const longPdf = await buildCustomerAgreementPdf({
        agreementType: CUSTOMER_AGREEMENT_TYPES.LONG_TIME,
        companyName: "Acme Shipping",
        brokerName: "Lia Torres",
        brokerTitle: "Broker",
        sentAt: new Date("2026-11-10T20:00:00Z"),
        fields: {
            legalCompanyName: "Acme Shipping",
            email: "alex@example.com",
        },
        timezone: "America/Los_Angeles",
    });
    const onePdf = await buildCustomerAgreementPdf({
        agreementType: CUSTOMER_AGREEMENT_TYPES.USHIP_ONETIME,
        companyName: "Acme Shipping",
        brokerName: "Lia Torres",
        brokerTitle: "Broker",
        sentAt: new Date("2026-11-10T20:00:00Z"),
        fields: {
            fullLegalName: "Alex Customer",
            companyName: "Acme Shipping",
            email: "alex@example.com",
        },
        timezone: "America/Los_Angeles",
    });
    assert.equal(longPdf.subarray(0, 4).toString("utf8"), "%PDF");
    assert.equal(onePdf.subarray(0, 4).toString("utf8"), "%PDF");
    assert.ok(longPdf.length > onePdf.length);
    assert.ok(
        customerAgreementTerms(CUSTOMER_AGREEMENT_TYPES.LONG_TIME).length >
            customerAgreementTerms(CUSTOMER_AGREEMENT_TYPES.USHIP_ONETIME).length
    );
});
