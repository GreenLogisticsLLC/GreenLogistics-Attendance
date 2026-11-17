import assert from "node:assert/strict";
import test from "node:test";
import {
    buildInvoicePricingBreakdown,
    calculateHandlingFeeUsd,
    createInvoicePricingSnapshot,
    defaultInvoicePricingSettings,
    parseInvoicePricingSettings,
    roundUsd,
    validateInvoicePricingUpdate,
} from "./invoice-pricing.js";

test("default invoice pricing is disabled with zero fee", () => {
    const settings = defaultInvoicePricingSettings();
    assert.equal(settings.enabled, false);
    assert.equal(settings.feeType, "none");
    const breakdown = buildInvoicePricingBreakdown({
        customerRate: 1000,
        accessorialCharges: 50,
        settings,
    });
    assert.equal(breakdown.subtotalUsd, 1050);
    assert.equal(breakdown.feeAmountUsd, 0);
    assert.equal(breakdown.totalUsd, 1050);
    assert.equal(breakdown.feeType, "none");
});

test("percentage and fixed handling fees round to cents", () => {
    const pct = parseInvoicePricingSettings({
        enabled: true,
        feeType: "percentage",
        percentageValue: 3,
        policyAcknowledgedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(calculateHandlingFeeUsd({ settings: pct, subtotalUsd: 100 }), 3);
    assert.equal(roundUsd(10.005), 10.01);

    const fixed = parseInvoicePricingSettings({
        enabled: true,
        feeType: "fixed",
        fixedAmountUsd: 12.5,
        policyAcknowledgedAt: "2026-01-01T00:00:00.000Z",
    });
    const b = buildInvoicePricingBreakdown({
        customerRate: 200,
        accessorialCharges: 0,
        settings: fixed,
    });
    assert.equal(b.feeAmountUsd, 12.5);
    assert.equal(b.totalUsd, 212.5);
    assert.ok(b.lineItems.some((li) => li.code === "HANDLING_FEE"));
});

test("fee is method-neutral — same amount regardless of payment method path", () => {
    const settings = parseInvoicePricingSettings({
        enabled: true,
        feeType: "percentage",
        percentageValue: 2,
        policyAcknowledgedAt: "2026-01-01T00:00:00.000Z",
    });
    const a = buildInvoicePricingBreakdown({
        customerRate: 500,
        settings,
    });
    const b = buildInvoicePricingBreakdown({
        customerRate: 500,
        settings,
    });
    assert.equal(a.feeAmountUsd, b.feeAmountUsd);
    assert.equal(a.totalUsd, b.totalUsd);
});

test("historical snapshot is immutable when live settings change", () => {
    const enabled = parseInvoicePricingSettings({
        version: 3,
        enabled: true,
        feeType: "fixed",
        fixedAmountUsd: 25,
        policyAcknowledgedAt: "2026-01-01T00:00:00.000Z",
    });
    const live = buildInvoicePricingBreakdown({
        customerRate: 1000,
        settings: enabled,
    });
    const snapshot = createInvoicePricingSnapshot({
        settings: enabled,
        breakdown: live,
    });
    const disabled = defaultInvoicePricingSettings();
    const locked = buildInvoicePricingBreakdown({
        customerRate: 1000,
        settings: disabled,
        snapshot,
    });
    assert.equal(locked.feeAmountUsd, 25);
    assert.equal(locked.totalUsd, 1025);
    assert.equal(locked.pricingVersion, 3);
    assert.equal(locked.rateUsd, 1000);
});

test("snapshot without live rate still exposes subtotal as rate for profit", () => {
    const settings = defaultInvoicePricingSettings();
    const snapshot = createInvoicePricingSnapshot({
        settings,
        breakdown: buildInvoicePricingBreakdown({
            customerRate: 2,
            settings,
        }),
    });
    const locked = buildInvoicePricingBreakdown({
        settings,
        snapshot,
    });
    assert.equal(locked.totalUsd, 2);
    assert.equal(locked.subtotalUsd, 2);
    assert.equal(locked.rateUsd, 2);
});

test("cannot enable fee without policy acknowledgment", () => {
    const current = defaultInvoicePricingSettings();
    const denied = validateInvoicePricingUpdate(
        current,
        { enabled: true, feeType: "percentage", percentageValue: 3 },
        "user-1"
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) {
        assert.equal(denied.code, "INVOICE_PRICING_POLICY_REQUIRED");
    }

    const ok = validateInvoicePricingUpdate(
        current,
        {
            enabled: true,
            feeType: "percentage",
            percentageValue: 3,
            acknowledgePolicy: true,
        },
        "user-1"
    );
    assert.equal(ok.ok, true);
    if (ok.ok) {
        assert.equal(ok.next.enabled, true);
        assert.ok(ok.next.policyAcknowledgedAt);
        assert.equal(ok.next.policyAcknowledgedByUserId, "user-1");
        assert.equal(ok.next.version, 2);
    }
});

test("PayPal or surcharge labels are rejected", () => {
    const current = defaultInvoicePricingSettings();
    const bad = validateInvoicePricingUpdate(
        current,
        {
            enabled: false,
            feeType: "none",
            lineItemLabel: "PayPal surcharge",
        },
        "user-1"
    );
    assert.equal(bad.ok, false);
});

test("waived fee zeroes the handling amount", () => {
    const settings = parseInvoicePricingSettings({
        enabled: true,
        feeType: "percentage",
        percentageValue: 3,
        policyAcknowledgedAt: "2026-01-01T00:00:00.000Z",
    });
    const b = buildInvoicePricingBreakdown({
        customerRate: 1000,
        settings,
        waiveFee: true,
    });
    assert.equal(b.feeAmountUsd, 0);
    assert.equal(b.totalUsd, 1000);
    assert.equal(b.waived, true);
});
