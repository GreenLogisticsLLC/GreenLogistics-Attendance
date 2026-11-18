import assert from "node:assert/strict";
import test from "node:test";
import {
    customerAmountUsd,
    isAccountingWorkEligible,
} from "./accounting-eligibility.js";

test("ghost load with only carrier rate is not Accounting-eligible", () => {
    assert.equal(
        isAccountingWorkEligible({
            status: "ACCEPT_GREEN",
            customerRate: null,
            price: null,
        }),
        false
    );
    assert.equal(customerAmountUsd({ customerRate: null, price: 0 }), null);
});

test("customer rate or invoice unlocks Accounting", () => {
    assert.equal(
        isAccountingWorkEligible({ status: "LOAD_CREATED", customerRate: 2656 }),
        true
    );
    assert.equal(
        isAccountingWorkEligible({
            status: "ACCEPT_GREEN",
            invoiceNumber: "GL10240",
            invoiceTotalUsd: 100,
        }),
        true
    );
});

test("voided loads are never Accounting-eligible", () => {
    assert.equal(
        isAccountingWorkEligible({ status: "VOIDED", customerRate: 500 }),
        false
    );
});
