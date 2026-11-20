import assert from "node:assert/strict";
import test from "node:test";
import {
    belongsInCarrierPayments,
    belongsInCustomerBilling,
} from "./payment-section-membership.js";

test("Customer PAID / Carrier UNPAID → Carrier Payments only", () => {
    const row = {
        status: "DELIVERED",
        customerPaidAt: "2026-11-01T00:00:00.000Z",
        carrierPaidAt: null,
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), false);
    assert.equal(belongsInCarrierPayments(row), true);
});

test("Customer UNPAID / Carrier PAID → Customer Billing only", () => {
    const row = {
        status: "DELIVERED",
        customerPaidAt: null,
        carrierPaidAt: "2026-11-01T00:00:00.000Z",
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), true);
    assert.equal(belongsInCarrierPayments(row), false);
});

test("Customer UNPAID / Carrier UNPAID → both sections", () => {
    const row = {
        status: "PICKUP",
        customerPaidAt: null,
        carrierPaidAt: null,
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), true);
    assert.equal(belongsInCarrierPayments(row), true);
});

test("Customer PAID / Carrier PAID → neither outstanding section", () => {
    const row = {
        status: "CLOSED",
        customerPaidAt: "2026-11-01T00:00:00.000Z",
        carrierPaidAt: "2026-11-02T00:00:00.000Z",
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), false);
    assert.equal(belongsInCarrierPayments(row), false);
});

test("voided loads are excluded from both sections", () => {
    const row = {
        status: "VOIDED",
        customerPaidAt: null,
        carrierPaidAt: null,
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), false);
    assert.equal(belongsInCarrierPayments(row), false);
});

test("membership ignores rates and ready flags — paid timestamps only", () => {
    const customerPaidCarrierUnpaid = {
        status: "PICKUP",
        customerPaidAt: new Date(),
        carrierPaidAt: null,
        accountingEligible: true,
    };
    assert.equal(belongsInCarrierPayments(customerPaidCarrierUnpaid), true);
    assert.equal(belongsInCustomerBilling(customerPaidCarrierUnpaid), false);
});
