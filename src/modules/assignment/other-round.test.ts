import assert from "node:assert/strict";
import test from "node:test";
import {
    brokersAtOtherOfferCap,
    brokersDueForOtherOffer,
    otherRoundIsClosed,
} from "./other-round.js";

test("second office round closes when everyone already had two Other offers", () => {
    const offers = new Map([
        ["a", 2],
        ["b", 2],
        ["c", 2],
    ]);
    assert.equal(
        otherRoundIsClosed({ eligibleIds: ["a", "b", "c"], offerCounts: offers, holderId: "c" }),
        true
    );
});

test("a person still waiting for a second offer keeps the shipment moving", () => {
    const offers = new Map([
        ["a", 2],
        ["b", 2],
        ["c", 1],
    ]);
    assert.equal(
        otherRoundIsClosed({ eligibleIds: ["a", "b", "c"], offerCounts: offers, holderId: "b" }),
        false
    );
    assert.deepEqual(brokersDueForOtherOffer(["a", "b", "c"], offers), ["c"]);
});

test("new walk-in can still get it, but people at the cap are excluded", () => {
    const offers = new Map([
        ["a", 2],
        ["b", 2],
        ["d", 0],
    ]);
    assert.equal(
        otherRoundIsClosed({ eligibleIds: ["a", "b", "d"], offerCounts: offers, holderId: "b" }),
        false
    );
    assert.deepEqual(brokersDueForOtherOffer(["a", "b", "d"], offers), ["d"]);
    assert.deepEqual(brokersAtOtherOfferCap(["a", "b", "d"], offers), ["a", "b"]);
});

test("holder under the cap does not close the round even if others are done", () => {
    const offers = new Map([
        ["a", 2],
        ["b", 2],
        ["c", 1],
    ]);
    assert.equal(
        otherRoundIsClosed({ eligibleIds: ["a", "b", "c"], offerCounts: offers, holderId: "c" }),
        false
    );
});
