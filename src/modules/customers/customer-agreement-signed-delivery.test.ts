import assert from "node:assert/strict";
import test from "node:test";
import {
    buildSignedCustomerAgreementBrokerEmail,
    CUSTOMER_AGREEMENT_TYPES,
} from "./customer-agreement.js";
import { LOAD_DOC_CHANGE_LABELS } from "../shipment/load.constants.js";

test("broker signed-agreement email mentions attached PDF and Accounting", () => {
    const mail = buildSignedCustomerAgreementBrokerEmail({
        companyName: "Acme Shipping",
        agreementType: CUSTOMER_AGREEMENT_TYPES.USHIP_ONETIME,
        brokerName: "Logan Harris",
        signerName: "Alex Customer",
        signedAtLabel: "November 12, 2026, 6:58 PM",
        loadNumber: "GL10199",
    });
    assert.match(mail.subject, /Signed/);
    assert.match(mail.subject, /Acme Shipping/);
    assert.match(mail.subject, /GL10199/);
    assert.match(mail.text, /Alex Customer/);
    assert.match(mail.text, /attached/i);
    assert.match(mail.text, /Accounting/);
    assert.match(mail.html, /Customer Documents/);
    assert.match(mail.html, /Logan Harris/);
});

test("FINAL_SIGNED is the change reason Accounting / Load Documents expect", () => {
    assert.equal(LOAD_DOC_CHANGE_LABELS.FINAL_SIGNED, "Final Signed");
});
