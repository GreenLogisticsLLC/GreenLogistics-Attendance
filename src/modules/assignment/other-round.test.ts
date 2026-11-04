import assert from "node:assert/strict";
import test from "node:test";
import { otherRoundIsClosed } from "./other-round.js";

test("second office round closes on the person who received it last", () => {
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
});

test("someone who just walked into the office must receive it twice too", () => {
    const offers = new Map([
        ["a", 2],
        ["b", 2],
        ["d", 0],
    ]);
    assert.equal(
        otherRoundIsClosed({ eligibleIds: ["a", "b", "d"], offerCounts: offers, holderId: "b" }),
        false
    );
});
