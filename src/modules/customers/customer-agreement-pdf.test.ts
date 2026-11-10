import assert from "node:assert/strict";
import test from "node:test";
import { buildCustomerAgreementPdf } from "./customer-agreement-pdf.js";
import { CUSTOMER_AGREEMENT_TYPES } from "./customer-agreement.js";

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
