import assert from "node:assert/strict";
import test from "node:test";
import { isCarrierPacketExcluded } from "../shipment/load-carrier-review.js";

/** Carrier Documents keeps one CURRENT RC/BOL/POD set (latest archived load). */
function retireCurrentPacketDocs(rows: Array<{ documentId: string; documentType: string; status: string }>) {
    return rows.map((row) =>
        ["RATE_CONFIRMATION", "BOL", "POD"].includes(row.documentType) && row.status === "CURRENT"
            ? { ...row, status: "ARCHIVED" }
            : row
    );
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
