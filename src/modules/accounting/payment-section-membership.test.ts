import assert from "node:assert/strict";
import test from "node:test";
import {
    belongsInCarrierPayments,
    belongsInCustomerBilling,
} from "./payment-section-membership.js";

test("PENDING load (e.g. GL10114) is not in Customer Billing or Carrier Payments", () => {
    const row = {
        status: "PICKUP",
        accountingDocStatus: "PENDING",
        customerPaidAt: null,
        carrierPaidAt: null,
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), false);
    assert.equal(belongsInCarrierPayments(row), false);
});

test("VERIFIED + customer UNPAID + carrier UNPAID → Customer Billing only", () => {
    const row = {
        status: "DELIVERED",
        accountingDocStatus: "VERIFIED",
        customerPaidAt: null,
        carrierPaidAt: null,
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), true);
    assert.equal(belongsInCarrierPayments(row), false);
});

test("VERIFIED + customer UNPAID + carrier PAID → Customer Billing only", () => {
    const row = {
        status: "DELIVERED",
        accountingDocStatus: "VERIFIED",
        customerPaidAt: null,
        carrierPaidAt: "2026-11-01T00:00:00.000Z",
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), true);
    assert.equal(belongsInCarrierPayments(row), false);
});

test("customer PAID + carrier UNPAID → Carrier Payments only (leave Billing)", () => {
    const row = {
        status: "DELIVERED",
        accountingDocStatus: "VERIFIED",
        customerPaidAt: "2026-11-01T00:00:00.000Z",
        carrierPaidAt: null,
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), false);
    assert.equal(belongsInCarrierPayments(row), true);
});

test("customer PAID + carrier PAID → neither outstanding section", () => {
    const row = {
        status: "CLOSED",
        accountingDocStatus: "VERIFIED",
        customerPaidAt: "2026-11-01T00:00:00.000Z",
        carrierPaidAt: "2026-11-02T00:00:00.000Z",
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), false);
    assert.equal(belongsInCarrierPayments(row), false);
});

test("Needs Correction is not Customer Billing", () => {
    const row = {
        status: "PICKUP",
        accountingDocStatus: "NEEDS_CORRECTION",
        customerPaidAt: null,
        carrierPaidAt: null,
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), false);
    assert.equal(belongsInCarrierPayments(row), false);
});

test("voided loads are excluded from both sections", () => {
    const row = {
        status: "VOIDED",
        accountingDocStatus: "VERIFIED",
        customerPaidAt: null,
        carrierPaidAt: null,
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), false);
    assert.equal(belongsInCarrierPayments(row), false);
});
