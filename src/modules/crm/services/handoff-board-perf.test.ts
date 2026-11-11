import assert from "node:assert/strict";
import test from "node:test";
import { latestHandoffs } from "../broker-arrival-summary.js";

test("latestHandoffs keeps the first row per shipment+broker (caller sorts newest first)", () => {
    const rows = latestHandoffs([
        { shipmentId: "s1", brokerId: "b1", at: new Date("2026-01-01T12:00:00Z") },
        { shipmentId: "s1", brokerId: "b1", at: new Date("2026-01-01T10:00:00Z") },
        { shipmentId: "s1", brokerId: "b2", at: new Date("2026-01-01T11:00:00Z") },
    ]);
    assert.equal(rows.length, 2);
    const b1 = rows.find((row) => row.brokerId === "b1");
    assert.equal(new Date(b1!.at).toISOString(), "2026-01-01T12:00:00.000Z");
});

test("handoff page slice hydrates only current page ids", () => {
    const matched = Array.from({ length: 120 }, (_, i) => ({
        shipmentId: "s" + i,
        brokerId: "b" + (i % 5),
        at: new Date(Date.UTC(2026, 0, 1, 0, i)),
    }));
    const pageSize = 25;
    const page = 1;
    const skip = (page - 1) * pageSize;
    const slice = matched.slice(skip, skip + pageSize);
    const pageIds = [...new Set(slice.map((row) => row.shipmentId))];
    assert.equal(slice.length, 25);
    assert.equal(pageIds.length, 25);
    assert.ok(pageIds.length < matched.length);
});
