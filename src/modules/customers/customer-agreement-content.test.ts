import assert from "node:assert/strict";
import test from "node:test";
import { CUSTOMER_AGREEMENT_TYPES } from "./customer-agreement.js";
import {
    customerAgreementSections,
    customerAgreementTerms,
} from "./customer-agreement-content.js";

test("Long Time agreement includes full master-agreement clauses", () => {
    const sections = customerAgreementSections(CUSTOMER_AGREEMENT_TYPES.LONG_TIME);
    const terms = customerAgreementTerms(CUSTOMER_AGREEMENT_TYPES.LONG_TIME);
    const titles = sections.map((s) => s.title).join("\n");
    const blob = terms.join("\n");
    assert.ok(sections.length >= 18);
    assert.ok(terms.length >= 80);
    assert.match(titles, /Purpose and Scope of Agreement/i);
    assert.match(titles, /Term and Termination/i);
    assert.match(titles, /Force Majeure/i);
    assert.match(blob, /automatically renew/i);
    assert.match(blob, /Truck Ordered but Not Used/i);
    assert.match(blob, /Commonwealth of Pennsylvania/i);
    assert.match(blob, /Master Customer–Broker Agreement/);
});

test("uShip OneTime agreement includes shipment-specific clauses", () => {
    const sections = customerAgreementSections(CUSTOMER_AGREEMENT_TYPES.USHIP_ONETIME);
    const terms = customerAgreementTerms(CUSTOMER_AGREEMENT_TYPES.USHIP_ONETIME);
    const titles = sections.map((s) => s.title).join("\n");
    const blob = terms.join("\n");
    assert.ok(sections.length >= 10);
    assert.ok(terms.length >= 40);
    assert.match(titles, /Broker's Services/i);
    assert.match(titles, /Cargo Insurance, Loss, and Damage/i);
    assert.match(blob, /No payment code may be requested before delivery/);
    assert.match(blob, /uShip cancellation process/);
    assert.match(blob, /this shipment/i);
    assert.match(blob, /Full payment after pickup/i);
    assert.match(blob, /50%\s*\/\s*50%/i);
});

test("Long Time and uShip OneTime bodies are distinct", () => {
    const long = customerAgreementTerms(CUSTOMER_AGREEMENT_TYPES.LONG_TIME).join("\n");
    const one = customerAgreementTerms(CUSTOMER_AGREEMENT_TYPES.USHIP_ONETIME).join("\n");
    assert.notEqual(long, one);
    assert.match(long, /one \(1\) year from its Effective Date/i);
    assert.doesNotMatch(one, /one \(1\) year from its Effective Date/i);
    assert.match(one, /No payment code may be requested before delivery/);
});
