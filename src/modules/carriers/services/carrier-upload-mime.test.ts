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

test("accepts Word / HEIC / Excel W-9 style uploads", () => {
    for (const sample of [
        { originalName: "W9.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
        { originalName: "w9.HEIC", mimeType: "image/heic" },
        { originalName: "form-w9.jpg", mimeType: "image/jpeg" },
        { originalName: "w9.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        { originalName: "scan.tif", mimeType: "image/tiff" },
        { originalName: "notes.txt", mimeType: "text/plain" },
        { originalName: "unknown.bin", mimeType: "application/octet-stream" },
    ]) {
        assert.doesNotThrow(
            () =>
                carrierStorageService.assertSafeUpload({
                    ...sample,
                    size: 80_000,
                }),
            sample.originalName
        );
    }
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

test("rejects html and javascript uploads", () => {
    assert.throws(
        () =>
            carrierStorageService.assertSafeUpload({
                originalName: "page.html",
                mimeType: "text/html",
                size: 1000,
            }),
        /not allowed|Executable/i
    );
    assert.throws(
        () =>
            carrierStorageService.assertSafeUpload({
                originalName: "x.js",
                mimeType: "application/javascript",
                size: 1000,
            }),
        /not allowed|Executable/i
    );
});
