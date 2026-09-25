import test from "node:test";
import assert from "node:assert/strict";
import { carrierStorageService } from "./carrier-storage.service.js";

test("accepts PDF sent as application/octet-stream (common for W-9)", () => {
    assert.doesNotThrow(() =>
        carrierStorageService.assertSafeUpload({
            originalName: "W-9.pdf",
            mimeType: "application/octet-stream",
            size: 120_000,
        })
    );
});

test("accepts normal application/pdf", () => {
    assert.doesNotThrow(() =>
        carrierStorageService.assertSafeUpload({
            originalName: "w9.pdf",
            mimeType: "application/pdf",
            size: 50_000,
        })
    );
});

test("rejects exe even with generic mime", () => {
    assert.throws(
        () =>
            carrierStorageService.assertSafeUpload({
                originalName: "virus.exe",
                mimeType: "application/octet-stream",
                size: 1000,
            }),
        /not allowed|Executable/i
    );
});
