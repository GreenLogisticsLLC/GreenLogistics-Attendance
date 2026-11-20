import assert from "node:assert/strict";
import test from "node:test";
import {
    belongsInCarrierPayments,
    belongsInCustomerBilling,
} from "./payment-section-membership.js";

test("PENDING without invoice is not in Carrier Payments", () => {
    const row = {
        status: "PICKUP",
        accountingDocStatus: "PENDING",
        customerPaidAt: null,
        carrierPaidAt: null,
        accountingReadyForCarrierPayment: false,
        hasCarrierInvoice: false,
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), false);
    assert.equal(belongsInCarrierPayments(row), false);
});

test("carrier invoice alone (customer UNPAID) → Carrier Payments", () => {
    const row = {
        status: "DELIVERED",
        accountingDocStatus: "PENDING",
        customerPaidAt: null,
        carrierPaidAt: null,
        accountingReadyForCarrierPayment: true,
        hasCarrierInvoice: true,
        accountingEligible: true,
    };
    assert.equal(belongsInCarrierPayments(row), true);
    assert.equal(belongsInCustomerBilling(row), false);
});

test("VERIFIED without carrier invoice is not in Carrier Payments", () => {
    const row = {
        status: "DELIVERED",
        accountingDocStatus: "VERIFIED",
        customerPaidAt: "2026-11-01T00:00:00.000Z",
        carrierPaidAt: null,
        accountingReadyForCarrierPayment: false,
        hasCarrierInvoice: false,
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), false);
    assert.equal(belongsInCarrierPayments(row), false);
});

test("VERIFIED + carrier invoice + customer PAID + carrier UNPAID → Carrier Payments", () => {
    const row = {
        status: "DELIVERED",
        accountingDocStatus: "VERIFIED",
        customerPaidAt: "2026-11-01T00:00:00.000Z",
        carrierPaidAt: null,
        accountingReadyForCarrierPayment: true,
        hasCarrierInvoice: true,
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), false);
    assert.equal(belongsInCarrierPayments(row), true);
});

test("carrier invoice via document alone counts for Carrier Payments", () => {
    const row = {
        status: "DELIVERED",
        accountingDocStatus: "VERIFIED",
        customerPaidAt: null,
        carrierPaidAt: null,
        accountingReadyForCarrierPayment: false,
        hasCarrierInvoice: true,
        accountingEligible: true,
    };
    assert.equal(belongsInCarrierPayments(row), true);
});

test("VERIFIED + customer UNPAID + carrier invoice → both Billing and Carrier Payments", () => {
    const row = {
        status: "DELIVERED",
        accountingDocStatus: "VERIFIED",
        customerPaidAt: null,
        carrierPaidAt: null,
        accountingReadyForCarrierPayment: true,
        hasCarrierInvoice: true,
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), true);
    assert.equal(belongsInCarrierPayments(row), true);
});

test("VERIFIED + customer UNPAID + carrier PAID → Customer Billing only", () => {
    const row = {
        status: "DELIVERED",
        accountingDocStatus: "VERIFIED",
        customerPaidAt: null,
        carrierPaidAt: "2026-11-01T00:00:00.000Z",
        accountingReadyForCarrierPayment: true,
        hasCarrierInvoice: true,
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), true);
    assert.equal(belongsInCarrierPayments(row), false);
});

test("both PAID → neither outstanding section", () => {
    const row = {
        status: "CLOSED",
        accountingDocStatus: "VERIFIED",
        customerPaidAt: "2026-11-01T00:00:00.000Z",
        carrierPaidAt: "2026-11-02T00:00:00.000Z",
        accountingReadyForCarrierPayment: true,
        hasCarrierInvoice: true,
        accountingEligible: true,
    };
    assert.equal(belongsInCustomerBilling(row), false);
    assert.equal(belongsInCarrierPayments(row), false);
});
