import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeCustomerAgreementType } from "./customer-agreement.js";

describe("uShip Create Load customer email options", () => {
    it("accepts the same agreement radios as Direct Create Load", () => {
        assert.equal(normalizeCustomerAgreementType("USHIP_ONETIME"), "USHIP_ONETIME");
        assert.equal(normalizeCustomerAgreementType("LONG_TIME"), "LONG_TIME");
        assert.equal(normalizeCustomerAgreementType(""), null);
        assert.equal(normalizeCustomerAgreementType(null), null);
    });

    it("defaults uShip OneTime when sendAgreement is true without type", () => {
        const fromBody = normalizeCustomerAgreementType("");
        const fallback = fromBody || normalizeCustomerAgreementType("USHIP_ONETIME");
        assert.equal(fallback, "USHIP_ONETIME");
    });
});
