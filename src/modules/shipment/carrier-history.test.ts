import assert from "node:assert/strict";
import test from "node:test";
import {
    appendCarrierHistory,
    parseCarrierHistory,
    statusAfterUnvoid,
} from "./carrier-history.js";

test("appendCarrierHistory keeps previous carrier on the same load number", () => {
    const json = appendCarrierHistory(null, {
        carrierName: "Fastex Logistics Inc.",
        carrierEmail: "ops@fastex.example",
        carrierPhone: null,
        carrierMc: "123",
        carrierDot: null,
        carrierProfileId: "c1",
        carrierRate: 2400,
        reason: "carrier_change",
        replacedAt: "2026-11-10T12:00:00.000Z",
    });
    const rows = parseCarrierHistory(json);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].carrierName, "Fastex Logistics Inc.");
    assert.equal(rows[0].carrierEmail, "ops@fastex.example");
});

test("statusAfterUnvoid restores prior status or falls back to CARRIER_ASSIGNED", () => {
    assert.equal(statusAfterUnvoid("RATE_CON_GENERATED"), "RATE_CON_GENERATED");
    assert.equal(statusAfterUnvoid("VOIDED"), "CARRIER_ASSIGNED");
    assert.equal(statusAfterUnvoid(null), "CARRIER_ASSIGNED");
});
