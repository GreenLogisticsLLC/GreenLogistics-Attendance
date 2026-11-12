import assert from "node:assert/strict";
import test from "node:test";
import {
    carrierAmountFromRateConContent,
    customerAmountFromInvoiceContent,
    parseMoneyValue,
    preferRateConCarrierAmount,
} from "./load-amounts.js";

test("parseMoneyValue accepts currency strings", () => {
    assert.equal(parseMoneyValue("$1,150.00"), 1150);
    assert.equal(parseMoneyValue("1000"), 1000);
    assert.equal(parseMoneyValue(""), null);
    assert.equal(parseMoneyValue(null), null);
});

test("carrierAmountFromRateConContent prefers flatRate over carrierRate", () => {
    assert.equal(
        carrierAmountFromRateConContent({ flatRate: 1150, carrierRate: 1000 }),
        1150
    );
    assert.equal(carrierAmountFromRateConContent({ carrierRate: "$1000" }), 1000);
    assert.equal(carrierAmountFromRateConContent({ flatRate: "$1,150.00" }), 1150);
    assert.equal(carrierAmountFromRateConContent({}), null);
});

test("preferRateConCarrierAmount uses last RC Flat Rate over stale books", () => {
    assert.equal(
        preferRateConCarrierAmount(1000, { flatRate: 1150, carrierRate: 1000 }),
        1150
    );
    assert.equal(preferRateConCarrierAmount(1000, { flatRate: "$1,150.00" }), 1150);
    assert.equal(preferRateConCarrierAmount(1000, {}), 1000);
    assert.equal(preferRateConCarrierAmount(null, { carrierRate: "900" }), 900);
    assert.equal(preferRateConCarrierAmount(null, null), null);
});

test("customerAmountFromInvoiceContent prefers totals", () => {
    assert.equal(
        customerAmountFromInvoiceContent({
            totalAmountDue: 2200,
            customerRate: 100,
        }),
        2200
    );
});
