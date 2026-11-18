import assert from "node:assert/strict";
import test from "node:test";
import {
    parsePaymentAmount,
    validateCarrierChangePreviousInfo,
} from "./carrier-change.js";
import {
    normalizeSettlementStatus,
    settlementsVisibleToAccounting,
    sumPayablePreviousCarrierExpenses,
} from "./previous-carrier-settlement.js";

test("Carrier Change rejects negative payment amounts", () => {
    assert.throws(() => parsePaymentAmount(-1), /cannot be negative/);
    assert.equal(parsePaymentAmount(0), 0);
    assert.equal(parsePaymentAmount("100.50"), 100.5);
});

test("Carrier Change previous info requires enums and allows $0", () => {
    const info = validateCarrierChangePreviousInfo({
        changeReason: "Rate Disagreement",
        previousCarrierStatus: "Cancelled Before Pickup",
        paymentAmount: 0,
        paymentReason: "TONU",
        brokerComment: "ok",
    });
    assert.equal(info.changeReason, "RATE_DISAGREEMENT");
    assert.equal(info.previousCarrierStatus, "CANCELLED_BEFORE_PICKUP");
    assert.equal(info.paymentAmount, 0);
    assert.equal(info.paymentReason, "TONU");
    assert.equal(normalizeSettlementStatus(null, info.paymentAmount), "NO_PAYMENT_REQUIRED");
    assert.equal(settlementsVisibleToAccounting([{ paymentAmount: 0 }]).length, 0);
});

test("Positive previous payment goes to Accounting and counts once in profit", () => {
    const info = validateCarrierChangePreviousInfo({
        changeReason: "CARRIER_CANCELLATION",
        previousCarrierStatus: "FAILED_TO_PERFORM",
        paymentAmount: 100,
        paymentReason: "CANCELLATION_FEE",
    });
    assert.equal(normalizeSettlementStatus(null, info.paymentAmount), "PENDING_ACCOUNTING");
    const rows = [
        { paymentAmount: 100, status: "PENDING_ACCOUNTING" },
        { paymentAmount: 100, status: "APPROVED" },
        { paymentAmount: 100, status: "PAID" },
        { paymentAmount: 50, status: "REJECTED" },
    ];
    assert.equal(settlementsVisibleToAccounting(rows).length, 4);
    assert.equal(sumPayablePreviousCarrierExpenses(rows), 300);
});
