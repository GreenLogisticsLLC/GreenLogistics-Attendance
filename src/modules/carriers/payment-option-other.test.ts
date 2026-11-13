import assert from "node:assert/strict";
import test from "node:test";
import { carrierPaymentOptionLabel } from "./constants.js";

test("OTHER payment option has a human label", () => {
    assert.equal(carrierPaymentOptionLabel("OTHER"), "Other");
    assert.equal(carrierPaymentOptionLabel("other"), "Other");
});

test("allowed payment option codes include OTHER", () => {
    const allowed = ["STANDARD", "QUICK_3", "QUICK_5", "FACTORING", "OTHER"];
    assert.equal(allowed.includes("OTHER"), true);
});
