import test from "node:test";
import assert from "node:assert/strict";
import { pickAgreementToKeep } from "./agreement-copies.js";

test("keeps the current agreement and treats older copies as extras", () => {
    const keep = pickAgreementToKeep([
        { documentId: "v14", status: "ARCHIVED", version: 14, uploadedAt: "2026-11-05T14:59:41.000Z" },
        { documentId: "v19", status: "CURRENT", version: 19, uploadedAt: "2026-11-05T16:24:12.000Z" },
        { documentId: "v18", status: "ARCHIVED", version: 18, uploadedAt: "2026-11-05T16:04:30.000Z" },
    ]);
    assert.equal(keep?.documentId, "v19");
});

test("without a current row, keeps the highest version", () => {
    const keep = pickAgreementToKeep([
        { documentId: "old", status: "ARCHIVED", version: 2, uploadedAt: "2026-11-05T16:00:00.000Z" },
        { documentId: "newer", status: "ARCHIVED", version: 5, uploadedAt: "2026-11-05T15:00:00.000Z" },
    ]);
    assert.equal(keep?.documentId, "newer");
});

test("empty list keeps nothing", () => {
    assert.equal(pickAgreementToKeep([]), null);
});
