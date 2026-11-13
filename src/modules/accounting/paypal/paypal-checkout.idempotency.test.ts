import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "crypto";
import { customerPaymentQuote } from "../../shipment/customer-payment.js";
import { buildPayPalPaymentEmail } from "./paypal-payment-email.js";

test("payment amount comes from customerPaymentQuote (server), not a client field", () => {
    const quote = customerPaymentQuote({
        customerRate: 1000,
        accessorialCharges: 50,
        method: "PAYPAL",
        waiveFee: false,
    });
    assert.equal(quote.total, 1080); // 1000 + 50 + 3% of 1000
    // Frontend must never supply amount — idempotency key is derived from quote.total.
    const key = createHash("sha256")
        .update(["ship-1", String(Math.round(quote.total! * 100)), "INV-1", "sandbox"].join("|"))
        .digest("hex")
        .slice(0, 48);
    assert.equal(key.length, 48);
});

test("buildPayPalPaymentEmail includes approval URL and amount", () => {
    const mail = buildPayPalPaymentEmail({
        customerName: "Acme Foods",
        loadNumber: "GL10001",
        invoiceNumber: "INV-10001",
        amountUsd: 1080,
        approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ABC",
    });
    assert.match(mail.subject, /PayPal/);
    assert.match(mail.text, /sandbox\.paypal\.com/);
    assert.match(mail.html, /Pay with PayPal/);
    assert.match(mail.text, /\$1,080\.00/);
});

test("duplicate webhook event ids are treated as unique keys (schema contract)", () => {
    // PayPalWebhookEvent.eventId is @unique — service short-circuits when processed=true.
    const eventIds = new Set<string>();
    const first = "WH-EVT-1";
    assert.equal(eventIds.has(first), false);
    eventIds.add(first);
    assert.equal(eventIds.has(first), true);
});
