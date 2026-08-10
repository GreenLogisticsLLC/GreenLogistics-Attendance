import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { _carrierTestUtils } from "./services/carrier.service.js";
import { REQUIRED_CARRIER_DOC_TYPES } from "./constants.js";

test("onboarding token is hashed — raw token never equals hash", () => {
    const raw = _carrierTestUtils.newRawToken();
    const hash = _carrierTestUtils.hashToken(raw);
    assert.equal(hash.length, 64);
    assert.notEqual(raw, hash);
    assert.equal(_carrierTestUtils.hashToken(raw), hash);
});

test("token is long enough for security", () => {
    const raw = _carrierTestUtils.newRawToken();
    assert.ok(raw.length >= 40);
});

test("required document types include MC, NOA, W9", () => {
    assert.deepEqual([...REQUIRED_CARRIER_DOC_TYPES], ["MC_AUTHORITY", "NOA", "W9"]);
});

test("different tokens produce different hashes", () => {
    const a = _carrierTestUtils.newRawToken();
    const b = _carrierTestUtils.newRawToken();
    assert.notEqual(a, b);
    assert.notEqual(_carrierTestUtils.hashToken(a), _carrierTestUtils.hashToken(b));
});

test("sha256 helper matches node crypto", () => {
    const raw = "test-token";
    assert.equal(
        _carrierTestUtils.hashToken(raw),
        crypto.createHash("sha256").update(raw).digest("hex")
    );
});
