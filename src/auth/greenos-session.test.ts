import test from "node:test";
import assert from "node:assert/strict";
import { GREEN_OS_IDLE_MS, isGreenOsSessionFresh } from "./greenos-session.js";

test("a fresh sign-in is active", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    assert.equal(isGreenOsSessionFresh(new Date(now), now), true);
});

test("19 minutes of activity still receives shipments", () => {
    const now = Date.parse("2026-11-02T12:20:00Z");
    assert.equal(isGreenOsSessionFresh(new Date(now - 19 * 60 * 1000), now), true);
});

test("20 minutes without activity is signed out", () => {
    const now = Date.parse("2026-11-02T12:20:00Z");
    assert.equal(isGreenOsSessionFresh(new Date(now - GREEN_OS_IDLE_MS), now), false);
    assert.equal(isGreenOsSessionFresh(null, now), false);
});
