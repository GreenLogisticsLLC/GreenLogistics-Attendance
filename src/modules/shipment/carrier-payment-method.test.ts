import assert from "node:assert/strict";
import test from "node:test";
import {
    accountingCarrierPaymentMethodLabel,
    effectiveCarrierPaidReportingDate,
    formatAccountingPaymentDateInput,
    normalizeAccountingCarrierPaymentMethod,
    parseAccountingPaymentDate,
} from "./carrier-payment-method.js";

test("normalizes Accounting carrier payment methods", () => {
    assert.equal(normalizeAccountingCarrierPaymentMethod("zelle"), "ZELLE");
    assert.equal(normalizeAccountingCarrierPaymentMethod("PayPal"), "PAYPAL");
    assert.equal(normalizeAccountingCarrierPaymentMethod("VENMO"), "VENMO");
    assert.equal(normalizeAccountingCarrierPaymentMethod("Stripe"), "STRIPE");
    assert.equal(normalizeAccountingCarrierPaymentMethod("Factoring company"), "FACTORING");
    assert.equal(normalizeAccountingCarrierPaymentMethod("FACTORING"), "FACTORING");
    assert.equal(normalizeAccountingCarrierPaymentMethod("ACH"), "ACH");
    assert.equal(normalizeAccountingCarrierPaymentMethod("QUICK_3"), null);
    assert.equal(normalizeAccountingCarrierPaymentMethod(""), null);
});

test("labels Accounting carrier payment methods", () => {
    assert.equal(accountingCarrierPaymentMethodLabel("FACTORING"), "Factoring Company");
    assert.equal(accountingCarrierPaymentMethodLabel("ZELLE"), "Zelle");
});

test("payment date parse/format round-trips YYYY-MM-DD", () => {
    const d = parseAccountingPaymentDate("2026-11-07");
    assert.ok(d);
    assert.equal(formatAccountingPaymentDateInput(d), "2026-11-07");
    assert.equal(parseAccountingPaymentDate(""), null);
});

test("effective PAID reporting date prefers Accounting date and requires paid", () => {
    assert.equal(
        effectiveCarrierPaidReportingDate({
            carrierPaidAt: null,
            accountingCarrierPaymentDate: "2026-11-01",
        }),
        null
    );
    const fromAccounting = effectiveCarrierPaidReportingDate({
        carrierPaidAt: "2026-11-18T15:00:00.000Z",
        accountingCarrierPaymentDate: "2026-11-07",
    });
    assert.equal(formatAccountingPaymentDateInput(fromAccounting), "2026-11-07");
    const fromMarked = effectiveCarrierPaidReportingDate({
        carrierPaidAt: "2026-11-18T15:00:00.000Z",
        accountingCarrierPaymentDate: null,
    });
    assert.ok(fromMarked);
});
