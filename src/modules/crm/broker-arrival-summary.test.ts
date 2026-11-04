import assert from "node:assert/strict";
import test from "node:test";
import { brokerArrivalSummary, latestHandoffs } from "./broker-arrival-summary.js";

test("latest handoff keeps the newest give to each broker", () => {
    const rows = latestHandoffs([
        { shipmentId: "s1", brokerId: "rio", at: "2026-11-04T13:33:00.000Z" },
        { shipmentId: "s1", brokerId: "sandra", at: "2026-11-04T13:00:00.000Z" },
        { shipmentId: "s1", brokerId: "rio", at: "2026-11-04T12:00:00.000Z" },
    ]);
    assert.deepEqual(
        rows.map((row) => row.brokerId),
        ["rio", "sandra"]
    );
    assert.equal(rows[0].at, "2026-11-04T13:33:00.000Z");
});

test("summary counts New and Other separately by who received them", () => {
    const summary = brokerArrivalSummary(
        [
            { brokerId: "sandra", at: "2026-11-04T13:00:00.000Z" },
            { brokerId: "rio", at: "2026-11-04T13:33:00.000Z" },
            { brokerId: "sandra", at: "2026-11-04T14:10:00.000Z" },
        ],
        (id) => (id === "rio" ? "Rio Clark" : "Sandra Walker")
    );
    assert.deepEqual(
        summary.map((row) => [row.name, row.count, row.lastReceivedAt]),
        [
            ["Sandra Walker", 2, "2026-11-04T14:10:00.000Z"],
            ["Rio Clark", 1, "2026-11-04T13:33:00.000Z"],
        ]
    );
});
