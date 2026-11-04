import assert from "node:assert/strict";
import test from "node:test";
import {
    arrivalIsDayOff,
    dayOffEmployeeIdsFromRows,
    zonedDateTime,
} from "./helpers.js";

const ye = "Asia/Yerevan";

test("arrival after 17:00 Yerevan from 5 Nov 2026 is a day off", () => {
    assert.equal(arrivalIsDayOff(zonedDateTime("2026-11-05", "17:30", ye)), true);
    assert.equal(arrivalIsDayOff(zonedDateTime("2026-11-05", "17:00", ye)), false);
    assert.equal(arrivalIsDayOff(zonedDateTime("2026-11-04", "17:30", ye)), false);
    assert.equal(arrivalIsDayOff(zonedDateTime("2026-11-06", "00:30", ye)), true);
    assert.equal(arrivalIsDayOff(zonedDateTime("2026-11-06", "10:00", ye)), false);
});

test("a late arrival stays out of the office-day queue", () => {
    const now = zonedDateTime("2026-11-05", "18:00", ye);
    const ids = dayOffEmployeeIdsFromRows(
        [
            { employeeId: "late", firstEntry: zonedDateTime("2026-11-05", "17:30", ye) },
            { employeeId: "on-time", firstEntry: zonedDateTime("2026-11-05", "17:00", ye) },
            { employeeId: "old", firstEntry: zonedDateTime("2026-11-04", "17:30", ye) },
        ],
        now
    );
    assert.deepEqual(ids, ["late"]);
    const morning = dayOffEmployeeIdsFromRows(
        [{ employeeId: "late", firstEntry: zonedDateTime("2026-11-05", "17:30", ye) }],
        zonedDateTime("2026-11-06", "10:00", ye)
    );
    assert.deepEqual(morning, []);
});
