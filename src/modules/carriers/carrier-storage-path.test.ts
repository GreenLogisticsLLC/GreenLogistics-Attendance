import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    CARRIER_UPLOADS_ROOT,
    carrierDocumentExists,
    migrateLegacyCarrierUploads,
    recoverLooseCarrierFile,
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
        assert.equal(carrierDocumentExists(carrierId, storageKey), true);
        assert.equal(carrierDocumentExists(carrierId, "missing.pdf"), false);
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

test("recoverLooseCarrierFile finds orphan by type/version/name after storageKey wipe", () => {
    const carrierId = `test-recover-${Date.now()}`;
    const body = Buffer.from("Current Authority.png content for MC");
    const checksum = crypto.createHash("sha256").update(body).digest("hex");
    const orphanKey = "MC_AUTHORITY_v1_999_Current Authority.png";
    const legacyRoot = path.join(process.cwd(), "dist", "uploads", "carriers");
    const dir = path.join(legacyRoot, carrierId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, orphanKey), body);
    const lostKey = "MC_AUTHORITY_v1_111_Current Authority.png";
    try {
        assert.equal(resolveCarrierDocumentAbsolutePath(carrierId, lostKey), null);
        const recovered = recoverLooseCarrierFile({
            carrierId,
            documentType: "MC_AUTHORITY",
            version: 1,
            originalFilename: "Current Authority.png",
            checksum,
            storageKey: lostKey,
        });
        assert.ok(recovered);
        assert.equal(recovered.storageKey, lostKey);
        assert.ok(fs.existsSync(recovered.absolutePath));
        assert.ok(recovered.absolutePath.startsWith(path.join(CARRIER_UPLOADS_ROOT, carrierId)));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(path.join(CARRIER_UPLOADS_ROOT, carrierId), { recursive: true, force: true });
    }
});

test("migrateLegacyCarrierUploads copies dist leftovers into cwd uploads", () => {
    const carrierId = `test-migrate-${Date.now()}`;
    const storageKey = "W9_v1_migrate_test.pdf";
    const legacyRoot = path.join(process.cwd(), "dist", "uploads", "carriers");
    const srcDir = path.join(legacyRoot, carrierId);
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, storageKey), "%PDF-1.4 migrate");
    try {
        const result = migrateLegacyCarrierUploads();
        assert.ok(result.copied >= 1);
        const dest = path.join(CARRIER_UPLOADS_ROOT, carrierId, storageKey);
        assert.ok(fs.existsSync(dest));
        assert.equal(resolveCarrierDocumentAbsolutePath(carrierId, storageKey), dest);
    } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(path.join(CARRIER_UPLOADS_ROOT, carrierId), { recursive: true, force: true });
    }
});
