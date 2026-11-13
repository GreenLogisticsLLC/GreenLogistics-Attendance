import assert from "node:assert/strict";
import test from "node:test";
import {
    runClaimedCapture,
    stateForPayPalStatus,
    verifyCompletedCapture,
} from "./paypal-payment-safety.js";

test("strict capture accepts only matching COMPLETED USD evidence", () => {
    const verified = verifyCompletedCapture(
        {
            captureId: "CAP-1",
            status: "COMPLETED",
            amountValue: "1080.00",
            currencyCode: "USD",
        },
        { amountUsd: 1080, currency: "USD" }
    );
    assert.deepEqual(verified, {
        captureId: "CAP-1",
        amountUsd: 1080,
        currency: "USD",
    });
});

for (const status of ["APPROVED", "PENDING", "DENIED", "FAILED"]) {
    test(`${status} capture never passes strict payment verification`, () => {
        assert.throws(
            () =>
                verifyCompletedCapture(
                    {
                        captureId: "CAP-NOT-PAID",
                        status,
                        amountValue: "1080.00",
                        currencyCode: "USD",
                    },
                    { amountUsd: 1080, currency: "USD" }
                ),
            (err: { code?: string }) => err.code === "PAYPAL_CAPTURE_NOT_COMPLETED"
        );
    });
}

test("capture id present without COMPLETED is not payment proof", () => {
    assert.throws(
        () =>
            verifyCompletedCapture(
                {
                    captureId: "CAP-EXISTS",
                    status: "PENDING",
                    amountValue: "100.00",
                    currencyCode: "USD",
                },
                { amountUsd: 100, currency: "USD" }
            ),
        /not completed/
    );
});

test("wrong capture amount and currency are rejected", () => {
    assert.throws(
        () =>
            verifyCompletedCapture(
                {
                    captureId: "CAP-2",
                    status: "COMPLETED",
                    amountValue: "99.99",
                    currencyCode: "USD",
                },
                { amountUsd: 100, currency: "USD" }
            ),
        (err: { code?: string }) => err.code === "PAYPAL_CAPTURE_AMOUNT_MISMATCH"
    );
    assert.throws(
        () =>
            verifyCompletedCapture(
                {
                    captureId: "CAP-3",
                    status: "COMPLETED",
                    amountValue: "100.00",
                    currencyCode: "EUR",
                },
                { amountUsd: 100, currency: "USD" }
            ),
        (err: { code?: string }) => err.code === "PAYPAL_CAPTURE_CURRENCY_MISMATCH"
    );
});

test("simultaneous capture runners make one financial call", async () => {
    let claimed = false;
    let captureCalls = 0;
    let reconcileCalls = 0;
    const run = () =>
        runClaimedCapture({
            claim: async () => {
                if (claimed) return false;
                claimed = true;
                return true;
            },
            capture: async () => {
                captureCalls += 1;
                await new Promise((resolve) => setTimeout(resolve, 20));
                return "captured";
            },
            reconcile: async () => {
                reconcileCalls += 1;
                return "pending";
            },
        });

    const results = await Promise.all([run(), run(), run()]);
    assert.equal(captureCalls, 1);
    assert.equal(reconcileCalls, 2);
    assert.deepEqual(results.sort(), ["captured", "pending", "pending"]);
});

test("PayPal state normalization is explicit", () => {
    assert.equal(stateForPayPalStatus("APPROVED"), "APPROVED");
    assert.equal(stateForPayPalStatus("PENDING"), "CAPTURE_PENDING");
    assert.equal(stateForPayPalStatus("DENIED"), "DENIED");
    assert.equal(stateForPayPalStatus("VOIDED"), "CANCELLED");
    assert.equal(stateForPayPalStatus("REFUNDED"), "REFUNDED");
});
