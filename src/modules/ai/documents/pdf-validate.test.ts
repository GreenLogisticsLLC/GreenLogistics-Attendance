import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { validatePdfFile, assertValidPdfOrThrow } from "./pdf-validate.js";
import { isPermanentInvalidPdfError } from "../../../utils/runtime-log.js";

describe("pdf-validate", () => {
    it("rejects empty / missing header", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-val-"));
        const bad = path.join(dir, "bad.pdf");
        fs.writeFileSync(bad, "not a pdf at all");
        const result = validatePdfFile(bad);
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.permanent, true);
            assert.match(result.reason, /PDF header/i);
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("rejects truncated PDF without %%EOF", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-val-"));
        const bad = path.join(dir, "trunc.pdf");
        fs.writeFileSync(bad, "%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
        const result = validatePdfFile(bad);
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.match(result.reason, /%%EOF/i);
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("accepts minimal structurally valid PDF", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-val-"));
        const ok = path.join(dir, "ok.pdf");
        fs.writeFileSync(
            ok,
            "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n"
        );
        const result = validatePdfFile(ok);
        assert.equal(result.ok, true);
        assert.doesNotThrow(() => assertValidPdfOrThrow(ok));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("classifies Invalid PDF structure as permanent", () => {
        assert.equal(isPermanentInvalidPdfError(new Error("Invalid PDF structure.")), true);
        assert.equal(isPermanentInvalidPdfError(new Error("network timeout")), false);
    });
});
