import assert from "node:assert/strict";
import test from "node:test";
import {
    canEditCustomerSplitPayments,
    canWaiveCustomerPaymentFee,
    parseCustomerPaymentAmount,
    sumCustomerSplitPayments,
    customerPaymentQuote,
    normalizeCustomerPaymentMethod,
} from "./customer-payment.js";
import { parseInvoicePricingSettings } from "../accounting/invoice-pricing.js";

test("payment option names normalize without PayPal-only surcharge labels", () => {
    assert.equal(normalizeCustomerPaymentMethod("venmo"), "VENMO");
    assert.equal(normalizeCustomerPaymentMethod("credit card"), "CREDIT_CARD");
    assert.equal(normalizeCustomerPaymentMethod("cash app"), "CASHAPP");
    assert.equal(normalizeCustomerPaymentMethod("wire"), "WIRE");
    assert.equal(normalizeCustomerPaymentMethod(""), null);

    // Default policy: fee disabled → no handling fee for any method.
    const venmo = customerPaymentQuote({ customerRate: 5000, method: "VENMO" });
    assert.equal(venmo.label, "Venmo");
    assert.equal(venmo.fee, 0);
    assert.equal(venmo.total, 5000);

    const paypal = customerPaymentQuote({ customerRate: 5000, method: "PAYPAL" });
    assert.equal(paypal.label, "PayPal");
    assert.equal(paypal.fee, 0);
    assert.equal(paypal.total, 5000);

    const wire = customerPaymentQuote({ customerRate: 5000, method: "WIRE" });
    assert.equal(wire.fee, 0);
    assert.equal(wire.total, 5000);
});

test("enabled handling fee applies equally to PayPal and Wire", () => {
    const pricing = parseInvoicePricingSettings({
        enabled: true,
        feeType: "percentage",
        percentageValue: 3,
        policyAcknowledgedAt: "2026-01-01T00:00:00.000Z",
        version: 2,
    });
    const paypal = customerPaymentQuote({
        customerRate: 5000,
        accessorialCharges: 100,
        method: "PAYPAL",
        pricing,
    });
    const wire = customerPaymentQuote({
        customerRate: 5000,
        accessorialCharges: 100,
        method: "WIRE",
        pricing,
    });
    assert.equal(paypal.fee, 153); // 3% of subtotal 5100
    assert.equal(wire.fee, 153);
    assert.equal(paypal.total, wire.total);
    assert.equal(paypal.subtotal, 5100);
    assert.ok(paypal.lineItems.some((li) => li.code === "HANDLING_FEE"));
});

test("locked invoice snapshot ignores later settings changes", () => {
    const liveOff = parseInvoicePricingSettings({ enabled: false, feeType: "none" });
    const quote = customerPaymentQuote({
        customerRate: 1000,
        method: "PAYPAL",
        pricing: liveOff,
        pricingSnapshot: {
            version: 9,
            enabled: true,
            feeType: "fixed",
            configuredValue: 40,
            feeAmountUsd: 40,
            subtotalUsd: 1000,
            totalUsd: 1040,
            currency: "USD",
            lineItemLabel: "Handling fee",
            waived: false,
            capturedAt: "2026-01-02T00:00:00.000Z",
        },
    });
    assert.equal(quote.fromSnapshot, true);
    assert.equal(quote.fee, 40);
    assert.equal(quote.total, 1040);
    assert.equal(quote.pricingVersion, 9);
});

test("accounting, owner, manager, and administrator can waive the handling fee", () => {
    assert.equal(canWaiveCustomerPaymentFee("Accounting"), true);
    assert.equal(canWaiveCustomerPaymentFee("Owner"), true);
    assert.equal(canWaiveCustomerPaymentFee("Manager"), true);
    assert.equal(canWaiveCustomerPaymentFee("Administrator"), true);
    assert.equal(canWaiveCustomerPaymentFee("Broker"), false);
});

test("same roles can edit 50/50 customer payment days", () => {
    assert.equal(canEditCustomerSplitPayments("Accounting"), true);
    assert.equal(canEditCustomerSplitPayments("Broker"), false);
});

test("parseCustomerPaymentAmount accepts money strings and clears empty", () => {
    assert.equal(parseCustomerPaymentAmount(""), null);
    assert.equal(parseCustomerPaymentAmount(null), null);
    assert.equal(parseCustomerPaymentAmount("1,850.50"), 1850.5);
    assert.equal(parseCustomerPaymentAmount("$2000"), 2000);
    assert.equal(parseCustomerPaymentAmount("-1"), "invalid");
});

test("sumCustomerSplitPayments adds first + second amounts", () => {
    assert.equal(
        sumCustomerSplitPayments({
            customerFirstPaymentAmount: 1850,
            customerSecondPaymentAmount: 1850,
        }),
        3700
    );
    assert.equal(
        sumCustomerSplitPayments({
            customerFirstPaymentAmount: 1000,
            customerSecondPaymentAmount: null,
        }),
        1000
    );
});
