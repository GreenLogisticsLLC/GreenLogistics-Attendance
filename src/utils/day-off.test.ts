import assert from "node:assert/strict";
import test from "node:test";
import {
    arrivalIsDayOff,
    arrivedAfterDayOffCutoff,
    dayOffEmployeeIdsFromRows,
    formatYerevanTime,
    zonedDateTime,
} from "./helpers.js";

const ye = "Asia/Yerevan";

test("arrival after 17:30 Yerevan from 5 Nov 2026 is a day off", () => {
    assert.equal(arrivalIsDayOff(zonedDateTime("2026-11-05", "17:31", ye)), true);
    assert.equal(arrivalIsDayOff(zonedDateTime("2026-11-05", "17:30", ye)), false);
    assert.equal(arrivalIsDayOff(zonedDateTime("2026-11-05", "17:00", ye)), false);
    assert.equal(arrivalIsDayOff(zonedDateTime("2026-11-04", "17:45", ye)), false);
    assert.equal(arrivalIsDayOff(zonedDateTime("2026-11-06", "00:30", ye)), true);
    assert.equal(arrivalIsDayOff(zonedDateTime("2026-11-06", "10:00", ye)), false);
});

test("reports count every arrival after 17:30 Yerevan, including before 5 Nov", () => {
    const early = zonedDateTime("2026-11-04", "16:57", ye);
    const cutoff = zonedDateTime("2026-11-04", "17:30", ye);
    const late = zonedDateTime("2026-11-04", "17:31", ye);
    assert.equal(arrivedAfterDayOffCutoff(early), false);
    assert.equal(arrivedAfterDayOffCutoff(cutoff), false);
    assert.equal(arrivedAfterDayOffCutoff(late), true);
    assert.equal(arrivalIsDayOff(late), false);
    assert.equal(formatYerevanTime(early), "16:57:00");
});

test("a late arrival stays out of the office-day queue", () => {
    const now = zonedDateTime("2026-11-05", "18:00", ye);
    const ids = dayOffEmployeeIdsFromRows(
        [
            { employeeId: "late", firstEntry: zonedDateTime("2026-11-05", "17:31", ye) },
            { employeeId: "on-time", firstEntry: zonedDateTime("2026-11-05", "17:30", ye) },
            { employeeId: "old", firstEntry: zonedDateTime("2026-11-04", "18:00", ye) },
        ],
        now
    );
    assert.deepEqual(ids, ["late"]);
    const morning = dayOffEmployeeIdsFromRows(
        [{ employeeId: "late", firstEntry: zonedDateTime("2026-11-05", "17:31", ye) }],
        zonedDateTime("2026-11-06", "10:00", ye)
    );
    assert.deepEqual(morning, []);
});
