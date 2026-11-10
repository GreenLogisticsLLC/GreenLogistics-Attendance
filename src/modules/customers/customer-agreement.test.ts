import assert from "node:assert/strict";
import test from "node:test";
import {
    CUSTOMER_AGREEMENT_TYPES,
    customerAgreementFilename,
    normalizeCustomerAgreementType,
    readCustomerAgreementFile,
} from "./customer-agreement.js";

test("normalizes agreement type choices", () => {
    assert.equal(normalizeCustomerAgreementType("USHIP_ONETIME"), "USHIP_ONETIME");
    assert.equal(normalizeCustomerAgreementType("Broker Customer Long TIme"), "LONG_TIME");
    assert.equal(normalizeCustomerAgreementType("long-time"), "LONG_TIME");
    assert.equal(normalizeCustomerAgreementType(""), null);
});

test("agreement files exist with the expected attachment names", () => {
    const one = readCustomerAgreementFile(CUSTOMER_AGREEMENT_TYPES.USHIP_ONETIME);
    assert.equal(one.filename, "Broker Customer Uship OneTime.docx");
    assert.ok(one.content.length > 1000);
    assert.equal(
        customerAgreementFilename(CUSTOMER_AGREEMENT_TYPES.LONG_TIME),
        "Broker Customer Long TIme.docx"
    );
    const long = readCustomerAgreementFile(CUSTOMER_AGREEMENT_TYPES.LONG_TIME);
    assert.ok(long.content.length > 1000);
});
