import assert from "node:assert/strict";
import test from "node:test";

/** Mirrors assignment.engine owner override map updates (no DB). */
function applyOverride(
    raw: string | null,
    employeeId: string,
    enabled: boolean
): Record<string, string> {
    let map: Record<string, string> = {};
    if (raw) {
        try {
            map = JSON.parse(raw) as Record<string, string>;
        } catch {
            map = {};
        }
    }
    if (enabled) map[employeeId] = "2026-11-06T20:00:00.000Z";
    else delete map[employeeId];
    return map;
}

test("Owner Set In Office records an override so the broker joins the queue", () => {
    const next = applyOverride(null, "emp-alen", true);
    assert.deepEqual(Object.keys(next), ["emp-alen"]);
    assert.equal(Boolean(next["emp-alen"]), true);
});

test("Mark Out clears the Owner In Office override", () => {
    const withBoth = applyOverride(
        JSON.stringify({ "emp-alen": "t", "emp-finn": "t" }),
        "emp-alen",
        false
    );
    assert.deepEqual(Object.keys(withBoth), ["emp-finn"]);
});

test("override keeps a day-off broker eligible when Owner sets In Office", () => {
    const dayOff = new Set(["emp-late"]);
    const overrides = new Set(Object.keys(applyOverride(null, "emp-late", true)));
    const inOffice = [{ employeeId: "emp-late" }, { employeeId: "emp-on-time" }];
    const working = inOffice.filter(
        (entry) => overrides.has(entry.employeeId) || !dayOff.has(entry.employeeId)
    );
    assert.deepEqual(
        working.map((e) => e.employeeId),
        ["emp-late", "emp-on-time"]
    );
});
