import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    isPermanentGmailMissingError,
    isPermanentInvalidPdfError,
    runtimeLog,
} from "./runtime-log.js";

describe("runtime-log", () => {
    it("redacts secret-like detail", () => {
        const lines: string[] = [];
        const orig = console.log;
        console.log = (...args: unknown[]) => {
            lines.push(String(args[0] ?? ""));
        };
        try {
            runtimeLog("INFO", {
                module: "test",
                category: "SAFE",
                message: "hello",
                detail: "Authorization: Bearer super-secret-token",
                retryEligible: false,
            });
        } finally {
            console.log = orig;
        }
        assert.equal(lines.length, 1);
        assert.match(lines[0], /\[INFO\]/);
        assert.match(lines[0], /detail=\[redacted\]/);
        assert.doesNotMatch(lines[0], /super-secret/);
    });

    it("classifies permanent errors", () => {
        assert.equal(isPermanentInvalidPdfError(new Error("Invalid PDF structure")), true);
        assert.equal(
            isPermanentGmailMissingError({ code: 404, message: "Requested entity was not found." }),
            true
        );
    });
});
