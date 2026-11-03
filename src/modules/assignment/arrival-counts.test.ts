import assert from "node:assert/strict";
import test from "node:test";
import { arrivalCountsFor, summarizeShipmentArrivals } from "./arrival-counts.js";

test("new arrivals split into accept, declined, and still waiting", () => {
    const leads = new Map([
        ["kept", { assignedBrokerId: "aaron", acceptedAt: "2026-11-03T00:00:00.000Z" }],
        ["passed", { assignedBrokerId: "bob", acceptedAt: "2026-11-03T00:00:00.000Z" }],
        ["open", { assignedBrokerId: "aaron", acceptedAt: null }],
        ["other-only", { assignedBrokerId: "lia", acceptedAt: null }],
        ["gone", { assignedBrokerId: "bob", acceptedAt: null }],
    ]);
    const totals = summarizeShipmentArrivals({
        logs: [
            { userId: "aaron", eventType: "ASSIGNED", shipmentId: "kept" },
            { userId: "aaron", eventType: "ASSIGNED", shipmentId: "kept" },
            { userId: "aaron", eventType: "ASSIGNED", shipmentId: "passed" },
            { userId: "aaron", eventType: "ASSIGNED", shipmentId: "open" },
            { userId: "aaron", eventType: "REASSIGNED", shipmentId: "other-only" },
            { userId: "aaron", eventType: "ASSIGNED", shipmentId: "deleted" },
            { userId: "aaron", eventType: "ASSIGNED", shipmentId: null },
            { userId: "lia", eventType: "REASSIGNED", shipmentId: "gone" },
        ],
        leads,
    });
    assert.deepEqual(arrivalCountsFor(totals, "aaron"), {
        newShipments: 3,
        newAccepted: 1,
        newDeclined: 1,
        newWaiting: 1,
        otherShipments: 1,
    });
    assert.deepEqual(arrivalCountsFor(totals, "lia"), {
        newShipments: 0,
        newAccepted: 0,
        newDeclined: 0,
        newWaiting: 0,
        otherShipments: 1,
    });
    assert.equal(arrivalCountsFor(totals, "gary").newShipments, 0);
});
