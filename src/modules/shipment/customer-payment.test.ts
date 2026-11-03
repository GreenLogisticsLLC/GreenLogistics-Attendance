import assert from "node:assert/strict";
import test from "node:test";
import {
    canWaiveCustomerPaymentFee,
    customerPaymentQuote,
    normalizeCustomerPaymentMethod,
} from "./customer-payment.js";

test("payment option names and the four methods that add 3 percent", () => {
    assert.equal(normalizeCustomerPaymentMethod("venmo"), "VENMO");
    assert.equal(normalizeCustomerPaymentMethod("credit card"), "CREDIT_CARD");
    assert.equal(normalizeCustomerPaymentMethod("cash app"), "CASHAPP");
    assert.equal(normalizeCustomerPaymentMethod("wire"), "WIRE");
    assert.equal(normalizeCustomerPaymentMethod(""), null);

    const venmo = customerPaymentQuote({ customerRate: 5000, method: "VENMO" });
    assert.equal(venmo.label, "Venmo +3%");
    assert.equal(venmo.fee, 150);
    assert.equal(venmo.total, 5150);

    const card = customerPaymentQuote({ customerRate: 5000, accessorialCharges: 100, method: "CREDIT_CARD" });
    assert.equal(card.fee, 150);
    assert.equal(card.total, 5250);

    const wire = customerPaymentQuote({ customerRate: 5000, method: "WIRE" });
    assert.equal(wire.fee, 0);
    assert.equal(wire.total, 5000);

    const waived = customerPaymentQuote({ customerRate: 5000, method: "PAYPAL", waiveFee: true });
    assert.equal(waived.waived, true);
    assert.equal(waived.fee, 0);
    assert.equal(waived.total, 5000);
    assert.equal(waived.label, "PayPal");
});

test("only accounting, owner, and administrator can waive the 3 percent", () => {
    assert.equal(canWaiveCustomerPaymentFee("Accounting"), true);
    assert.equal(canWaiveCustomerPaymentFee("Owner"), true);
    assert.equal(canWaiveCustomerPaymentFee("Administrator"), true);
    assert.equal(canWaiveCustomerPaymentFee("Broker"), false);
    assert.equal(canWaiveCustomerPaymentFee("Manager"), false);
});
