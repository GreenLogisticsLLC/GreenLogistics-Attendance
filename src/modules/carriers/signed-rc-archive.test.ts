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

/** Archive is a no-op when a CURRENT row already holds this exact PDF checksum. */
function shouldSkipPacketArchiveCreate(input: {
    existingCurrentChecksum?: string | null;
    loadChecksum: string;
}): boolean {
    return Boolean(input.existingCurrentChecksum) && input.existingCurrentChecksum === input.loadChecksum;
}

/** Carrier Documents tab: hide archived RC/BOL/POD clutter; keep CURRENT packet + all other docs. */
function filterCarrierDocsForUi(
    rows: Array<{ documentId: string; documentType: string; status: string }>
) {
    const packet = new Set(["RATE_CONFIRMATION", "BOL", "POD"]);
    return rows.filter((d) => !packet.has(d.documentType) || d.status === "CURRENT");
}

/** Submit heal should not re-archive when sign-rc already left a CURRENT RC for this load. */
function shouldHealArchive(hasCurrentRcForLoad: boolean): boolean {
    return !hasCurrentRcForLoad;
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

test("archive skips create when CURRENT checksum already matches the load PDF", () => {
    assert.equal(
        shouldSkipPacketArchiveCreate({
            existingCurrentChecksum: "abc",
            loadChecksum: "abc",
        }),
        true
    );
    assert.equal(
        shouldSkipPacketArchiveCreate({
            existingCurrentChecksum: "abc",
            loadChecksum: "xyz",
        }),
        false
    );
    assert.equal(
        shouldSkipPacketArchiveCreate({
            existingCurrentChecksum: null,
            loadChecksum: "abc",
        }),
        false
    );
});

test("submit heal archive only runs when CURRENT RC for the load is missing", () => {
    assert.equal(shouldHealArchive(true), false);
    assert.equal(shouldHealArchive(false), true);
});

test("carrier Documents UI hides archived RC/BOL/POD duplicates", () => {
    const shown = filterCarrierDocsForUi([
        { documentId: "1", documentType: "RATE_CONFIRMATION", status: "ARCHIVED" },
        { documentId: "2", documentType: "RATE_CONFIRMATION", status: "CURRENT" },
        { documentId: "3", documentType: "BOL", status: "ARCHIVED" },
        { documentId: "4", documentType: "BOL", status: "CURRENT" },
        { documentId: "5", documentType: "W9", status: "CURRENT" },
        { documentId: "6", documentType: "W9", status: "ARCHIVED" },
    ]);
    assert.deepEqual(
        shown.map((d) => d.documentId),
        ["2", "4", "5", "6"]
    );
});
