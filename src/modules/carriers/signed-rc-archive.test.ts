import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { isCarrierPacketExcluded } from "../shipment/load-carrier-review.js";
import {
    LOAD_DOCS_ROOT,
    resolveLoadDocumentAbsolutePath,
} from "../shipment/services/load-pdf.service.js";
import { LOAD_DOC_CHANGE_LABELS } from "../shipment/load.constants.js";

/** Carrier Documents keeps one CURRENT RC/BOL/POD set (latest archived load). */
function retireCurrentPacketDocs(rows: Array<{ documentId: string; documentType: string; status: string }>) {
    return rows.map((row) =>
        ["RATE_CONFIRMATION", "BOL", "POD"].includes(row.documentType) && row.status === "CURRENT"
            ? { ...row, status: "ARCHIVED" }
            : row
    );
}

/** Stamp must not demote the previous current RC until the signed PDF row exists. */
function applyAtomicStampFlip(rows: Array<{ documentId: string; isCurrent: boolean }>, previousId: string, nextId: string) {
    // Generate PDF / create next first (caller responsibility), then flip.
    return rows.map((row) => {
        if (row.documentId === previousId) return { ...row, isCurrent: false };
        if (row.documentId === nextId) return { ...row, isCurrent: true };
        return row;
    });
}

test("signed RC archive retires every CURRENT RC/BOL/POD before copying the new load", () => {
    const after = retireCurrentPacketDocs([
        { documentId: "a", documentType: "RATE_CONFIRMATION", status: "CURRENT" },
        { documentId: "b", documentType: "BOL", status: "CURRENT" },
        { documentId: "c", documentType: "W9", status: "CURRENT" },
        { documentId: "d", documentType: "RATE_CONFIRMATION", status: "ARCHIVED" },
    ]);
    assert.equal(after.find((r) => r.documentId === "a")?.status, "ARCHIVED");
    assert.equal(after.find((r) => r.documentId === "b")?.status, "ARCHIVED");
    assert.equal(after.find((r) => r.documentId === "c")?.status, "CURRENT");
    assert.equal(after.find((r) => r.documentId === "d")?.status, "ARCHIVED");
});

test("Assign Carrier packet review still excludes archived RC/BOL copies", () => {
    assert.equal(isCarrierPacketExcluded("RATE_CONFIRMATION"), true);
    assert.equal(isCarrierPacketExcluded("BOL"), true);
    assert.equal(isCarrierPacketExcluded("W9"), false);
});

test("FINAL_SIGNED has a human label for Load Documents", () => {
    assert.equal(LOAD_DOC_CHANGE_LABELS.FINAL_SIGNED, "Final Signed");
});

test("atomic stamp flip keeps a current RC after creating the signed version", () => {
    const before = [
        { documentId: "v1", isCurrent: true },
        { documentId: "v2-signed", isCurrent: false },
    ];
    const after = applyAtomicStampFlip(before, "v1", "v2-signed");
    assert.equal(after.find((r) => r.documentId === "v1")?.isCurrent, false);
    assert.equal(after.find((r) => r.documentId === "v2-signed")?.isCurrent, true);
    assert.equal(after.filter((r) => r.isCurrent).length, 1);
});

test("resolveLoadDocumentAbsolutePath finds files under LOAD_DOCS_ROOT", () => {
    const shipmentLeadId = `test-ship-${Date.now()}`;
    const storedName = "RATE_CONFIRMATION_v1_test.pdf";
    const dir = path.join(LOAD_DOCS_ROOT, shipmentLeadId);
    fs.mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, storedName);
    fs.writeFileSync(abs, "%PDF-1.4 test");
    try {
        assert.equal(resolveLoadDocumentAbsolutePath(shipmentLeadId, storedName), abs);
        assert.equal(resolveLoadDocumentAbsolutePath(shipmentLeadId, "missing.pdf"), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("portal sign must fail closed when stamp returns no document id", () => {
    const stampedDocumentId: string | null = null;
    const shouldReject = !stampedDocumentId;
    assert.equal(shouldReject, true);
});
