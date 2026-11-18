import assert from "node:assert/strict";
import test from "node:test";
import {
    buildLoadFinancialSummary,
    settlementsVisibleToAccounting,
    statusAfterInvoiceUpload,
    sumPayablePreviousCarrierExpenses,
} from "./previous-carrier-settlement.js";
import { computePricing } from "./services/load.service.js";

test("Accounting hides $0 previous carriers and shows positive amounts separately", () => {
    const rows = [
        { settlementId: "a", paymentAmount: 0, status: "NO_PAYMENT_REQUIRED" },
        { settlementId: "b", paymentAmount: 100, status: "PENDING_ACCOUNTING" },
        { settlementId: "c", paymentAmount: 100, status: "APPROVED" },
    ];
    const visible = settlementsVisibleToAccounting(rows);
    assert.equal(visible.length, 2);
    assert.deepEqual(
        visible.map((r) => r.settlementId),
        ["b", "c"]
    );
});

test("Pending previous carrier payments count toward Load Profit once", () => {
    const previous = sumPayablePreviousCarrierExpenses([
        { paymentAmount: 100, status: "PENDING_ACCOUNTING" },
        { paymentAmount: 100, status: "INVOICE_UPLOADED" },
        { paymentAmount: 50, status: "REJECTED" },
        { paymentAmount: 0, status: "NO_PAYMENT_REQUIRED" },
        { paymentAmount: 100, status: "PAID" },
    ]);
    assert.equal(previous, 300);

    const pricing = computePricing(
        { customerRate: 3000, carrierRate: 2000 },
        { previousCarrierPayments: previous }
    );
    assert.equal(pricing.previousCarrierPayments, 300);
    assert.equal(pricing.finalCarrierPayment, 2000);
    assert.equal(pricing.totalCarrierExpenses, 2300);
    assert.equal(pricing.profit, 700);

    // Status change PAID must not change expense again.
    const afterPaid = sumPayablePreviousCarrierExpenses([
        { paymentAmount: 100, status: "PAID" },
        { paymentAmount: 100, status: "PAID" },
        { paymentAmount: 100, status: "PAID" },
    ]);
    assert.equal(afterPaid, 300);
});

test("Example: $3000 customer − $100 − $100 − $2000 final = $800 profit", () => {
    const summary = buildLoadFinancialSummary({
        customerPayment: 3000,
        previousCarrierPayments: 200,
        finalCarrierPayment: 2000,
    });
    assert.equal(summary.totalCarrierExpenses, 2200);
    assert.equal(summary.loadProfit, 800);
});

test("Invoice upload does not mark settlement PAID", () => {
    assert.equal(statusAfterInvoiceUpload("PENDING_ACCOUNTING", 100), "INVOICE_UPLOADED");
    assert.equal(statusAfterInvoiceUpload("PAID", 100), "PAID");
    assert.equal(statusAfterInvoiceUpload("REJECTED", 100), "REJECTED");
});
