import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    CARRIER_UPLOADS_ROOT,
    resolveCarrierDocumentAbsolutePath,
} from "./services/carrier-storage.service.js";

test("resolveCarrierDocumentAbsolutePath finds files under CARRIER_UPLOADS_ROOT", () => {
    const carrierId = `test-carrier-${Date.now()}`;
    const storageKey = "BROKER_CARRIER_AGREEMENT_v1_test_signed.pdf";
    const dir = path.join(CARRIER_UPLOADS_ROOT, carrierId);
    fs.mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, storageKey);
    fs.writeFileSync(abs, "%PDF-1.4 test agreement");
    try {
        assert.equal(resolveCarrierDocumentAbsolutePath(carrierId, storageKey), abs);
        assert.equal(resolveCarrierDocumentAbsolutePath(carrierId, "missing.pdf"), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("resolveCarrierDocumentAbsolutePath finds files under legacy dist/uploads", () => {
    const carrierId = `test-carrier-legacy-${Date.now()}`;
    const storageKey = "BROKER_CARRIER_AGREEMENT_v1_legacy_signed.pdf";
    const legacyRoot = path.join(process.cwd(), "dist", "uploads", "carriers");
    const dir = path.join(legacyRoot, carrierId);
    fs.mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, storageKey);
    fs.writeFileSync(abs, "%PDF-1.4 legacy agreement");
    try {
        assert.equal(resolveCarrierDocumentAbsolutePath(carrierId, storageKey), abs);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
