import assert from "node:assert/strict";
import test from "node:test";
import { GREEN_OS_ACTIVITY_MS, receivesNewShipments } from "./activity-window.js";

test("idle brokers and team leads do not receive shipments", () => {
    const now = new Date("2026-11-03T05:00:00.000Z");
    const fresh = new Date(now.getTime() - 19 * 60 * 1000);
    const idle = new Date(now.getTime() - GREEN_OS_ACTIVITY_MS - 1000);
    assert.equal(receivesNewShipments("Broker", fresh, now), true);
    assert.equal(receivesNewShipments("Team Lead", fresh, now), true);
    assert.equal(receivesNewShipments("Broker", idle, now), false);
    assert.equal(receivesNewShipments("Team Lead", idle, now), false);
    assert.equal(receivesNewShipments("Broker", null, now), true);
    assert.equal(receivesNewShipments("Owner", idle, now), true);
});
