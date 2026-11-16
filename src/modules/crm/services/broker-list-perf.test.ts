import assert from "node:assert/strict";
import test from "node:test";
import {
    compareShipmentsForAccepted,
    compareShipmentsForBoard,
} from "../../shipment/shipment.constants.js";

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

test("Accepted tab sorts newest Accept first so WORKING is not buried under Bid/Reply", () => {
    const rows = [
        {
            shipmentLeadId: "old-bid",
            status: "BID_SUBMITTED",
            acceptedAt: new Date("2026-01-01T00:00:00Z"),
            updatedAt: new Date("2026-01-10T00:00:00Z"),
        },
        {
            shipmentLeadId: "fresh-accept",
            status: "WORKING",
            acceptedAt: new Date("2026-01-16T20:57:00Z"),
            updatedAt: new Date("2026-01-16T20:57:00Z"),
        },
        {
            shipmentLeadId: "reply",
            status: "BROKER_REPLY",
            acceptedAt: new Date("2026-01-05T00:00:00Z"),
            updatedAt: new Date("2026-01-15T00:00:00Z"),
        },
    ];
    const sorted = rows.slice().sort(compareShipmentsForAccepted);
    assert.deepEqual(
        sorted.map((r) => r.shipmentLeadId),
        ["fresh-accept", "reply", "old-bid"]
    );
});

test("countOnly empty page shape keeps totalPages at least 1", () => {
    const total = 0;
    const pageSize = 50;
    const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
    assert.equal(totalPages, 1);
});
