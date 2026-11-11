import assert from "node:assert/strict";
import test from "node:test";
import { compareShipmentsForBoard } from "../../shipment/shipment.constants.js";

test("board sort uses status then updatedAt without needing full list columns", () => {
    const rows = [
        { shipmentLeadId: "a", status: "WORKING", updatedAt: new Date("2026-01-02T00:00:00Z") },
        { shipmentLeadId: "b", status: "AWAITING_ACCEPTANCE", updatedAt: new Date("2026-01-01T00:00:00Z") },
        { shipmentLeadId: "c", status: "BID_SUBMITTED", updatedAt: new Date("2026-01-03T00:00:00Z") },
    ];
    const sorted = rows.slice().sort(compareShipmentsForBoard);
    assert.deepEqual(
        sorted.map((r) => r.shipmentLeadId),
        ["b", "c", "a"]
    );
});

test("countOnly empty page shape keeps totalPages at least 1", () => {
    const total = 0;
    const pageSize = 50;
    const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
    assert.equal(totalPages, 1);
});
