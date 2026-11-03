import assert from "node:assert/strict";
import test from "node:test";
import { assignInTurns, queuePlaces, takeNextInQueue } from "./round-robin.js";

test("two brokers who stay eligible split new shipments one by one", () => {
    const picks = assignInTurns(["aaron", "bob"], 8);
    assert.deepEqual(picks, ["aaron", "bob", "aaron", "bob", "aaron", "bob", "aaron", "bob"]);
    const aaron = picks.filter((id) => id === "aaron").length;
    const bob = picks.filter((id) => id === "bob").length;
    assert.equal(aaron, 4);
    assert.equal(bob, 4);
    assert.ok(Math.abs(aaron - bob) <= 1);
});

test("three eligible people never differ by more than one shipment", () => {
    const picks = assignInTurns(["aaron", "lia", "maddy"], 10);
    const counts = new Map<string, number>();
    for (const id of picks) counts.set(id, (counts.get(id) || 0) + 1);
    const values = [...counts.values()];
    assert.equal(Math.max(...values) - Math.min(...values) <= 1, true);
    assert.equal(picks.length, 10);
});

test("a broker who steps out does not take the loads, and does not steal the line on return", () => {
    let state = { orderedUserIds: [] as string[], nextIndex: 0 };
    const both = ["aaron", "bob"];
    const onlyAaron = ["aaron"];
    const got: string[] = [];
    function give(eligible: string[]) {
        const turn = takeNextInQueue(state, eligible);
        assert.ok(turn);
        got.push(turn.chosenId);
        state = turn.state;
    }
    give(both);
    give(both);
    give(onlyAaron);
    give(onlyAaron);
    give(both);
    give(both);
    assert.deepEqual(got, ["aaron", "bob", "aaron", "aaron", "aaron", "bob"]);
});

test("queue board marks who receives next, who received last, and who is waiting", () => {
    const places = queuePlaces(["aaron", "bob", "lia"], 1, "aaron");
    assert.deepEqual(
        places.map((row) => row.place),
        ["received", "next", "waiting"]
    );
    const alone = queuePlaces(["aaron"], 0, "aaron");
    assert.deepEqual(alone.map((row) => row.place), ["next"]);
});

test("a missed accept is passed to the other broker, not back to the same one", () => {
    let state = { orderedUserIds: ["aaron", "bob"], nextIndex: 0 };
    const first = takeNextInQueue(state, ["aaron", "bob"]);
    assert.equal(first?.chosenId, "aaron");
    state = first!.state;
    const passed = takeNextInQueue(state, ["aaron", "bob"], ["aaron"]);
    assert.equal(passed?.chosenId, "bob");
});
