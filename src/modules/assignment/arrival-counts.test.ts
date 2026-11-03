import assert from "node:assert/strict";
import test from "node:test";
import { arrivalCountsFor, countShipmentArrivals } from "./arrival-counts.js";

test("new and other arrivals are counted separately for each person", () => {
    const totals = countShipmentArrivals([
        { userId: "aaron", eventType: "ASSIGNED", shipmentId: "s1", logId: "1" },
        { userId: "aaron", eventType: "ASSIGNED", shipmentId: "s1", logId: "2" },
        { userId: "aaron", eventType: "ASSIGNED", shipmentId: "s2", logId: "3" },
        { userId: "aaron", eventType: "REASSIGNED", shipmentId: "s3", logId: "4" },
        { userId: "lia", eventType: "REASSIGNED", shipmentId: "s3", logId: "5" },
        { userId: "lia", eventType: "REASSIGNED", shipmentId: "s3", logId: "6" },
        { userId: "lia", eventType: "QUEUE_JOIN", shipmentId: null, logId: "7" },
    ]);
    assert.deepEqual(arrivalCountsFor(totals, "aaron"), { newShipments: 2, otherShipments: 1 });
    assert.deepEqual(arrivalCountsFor(totals, "lia"), { newShipments: 0, otherShipments: 1 });
    assert.deepEqual(arrivalCountsFor(totals, "gary"), { newShipments: 0, otherShipments: 0 });
});
