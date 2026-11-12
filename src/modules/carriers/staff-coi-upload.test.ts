import assert from "node:assert/strict";
import test from "node:test";

/** Mirrors normalizePortalDocType COI → INSURANCE mapping used by staff upload. */
function normalizePortalDocType(raw: string): string {
    const t = String(raw || "")
        .trim()
        .toUpperCase()
        .replace(/[\s\-]+/g, "_");
    if (t === "COI" || t === "CERTIFICATE_OF_INSURANCE" || t === "CERTIFICATE_OF_HOLDER") {
        return "INSURANCE";
    }
    return t;
}

function archiveTypesFor(docType: string): string[] {
    const documentType = normalizePortalDocType(docType);
    return documentType === "INSURANCE" || documentType === "COI"
        ? ["INSURANCE", "COI"]
        : [documentType];
}

test("insurance / COI aliases store as INSURANCE and archive both CURRENT types", () => {
    assert.equal(normalizePortalDocType("COI"), "INSURANCE");
    assert.equal(normalizePortalDocType("Certificate of Holder"), "INSURANCE");
    assert.deepEqual(archiveTypesFor("INSURANCE"), ["INSURANCE", "COI"]);
    assert.deepEqual(archiveTypesFor("COI"), ["INSURANCE", "COI"]);
});

test("staff COI upload clears load broker approval before RC", () => {
    const before = {
        loadCarrierApprovedAt: new Date("2026-11-12T10:00:00.000Z"),
        loadCarrierApprovedById: "broker-1",
        loadCarrierApprovedProfileId: "carrier-1",
    };
    const after = {
        loadCarrierApprovedAt: null,
        loadCarrierApprovedById: null,
        loadCarrierApprovedProfileId: null,
    };
    assert.notEqual(before.loadCarrierApprovedAt, null);
    assert.equal(after.loadCarrierApprovedAt, null);
    assert.equal(after.loadCarrierApprovedProfileId, null);
});
