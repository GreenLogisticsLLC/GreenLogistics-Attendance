/**
 * Webhook payload handling smoke tests (pure helpers / fingerprints).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fingerprintEvent } from "./mapper.js";
import { mapCarrierViewError } from "./errors.js";

describe("webhook idempotency fingerprints", () => {
    it("same payload hashes equal", () => {
        const a = fingerprintEvent({
            eventType: "webhook_position",
            providerLoadId: "529",
            payload: { lat: 1, lng: 2 },
        });
        const b = fingerprintEvent({
            eventType: "webhook_position",
            providerLoadId: "529",
            payload: { lat: 1, lng: 2 },
        });
        assert.equal(a, b);
    });

    it("HTTP 200 + success:false still maps to error", () => {
        const err = mapCarrierViewError("creation_error", { field: "x" }, 200);
        assert.equal(err.code, "creation_error");
        assert.equal(err.httpStatus, 502);
    });
});
