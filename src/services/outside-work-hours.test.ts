import test from "node:test";
import assert from "node:assert/strict";
import {
    ATTENDANCE_DAY_START,
    ATTENDANCE_WORK_END,
    getAttendanceWorkHoursBounds,
    overlapMinutes,
    sumWorkHoursOutsideMinutes,
    zonedDateTime,
} from "../utils/helpers.js";

const TZ = "America/Los_Angeles";
const WORK_DATE = "2026-10-27";

test("work hours are 17:00 to 01:00 next day", () => {
    assert.equal(ATTENDANCE_DAY_START, "17:00");
    assert.equal(ATTENDANCE_WORK_END, "01:00");
    const { workStart, workEnd } = getAttendanceWorkHoursBounds(WORK_DATE, TZ);
    assert.equal(
        workStart.toLocaleString("en-GB", {
            timeZone: TZ,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        }),
        "17:00"
    );
    const endParts = workEnd.toLocaleString("en-GB", {
        timeZone: TZ,
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
    assert.match(endParts, /28/);
    assert.match(endParts, /01:00/);
});

test("break during work hours counts fully toward Total Outside", () => {
    const { workStart, workEnd } = getAttendanceWorkHoursBounds(WORK_DATE, TZ);
    const start = zonedDateTime(WORK_DATE, "18:00", TZ);
    const end = zonedDateTime(WORK_DATE, "18:20", TZ);
    assert.equal(overlapMinutes(start, end, workStart, workEnd), 20);
    assert.equal(
        sumWorkHoursOutsideMinutes([{ startTime: start, endTime: end }], end, workStart, workEnd),
        20
    );
});

test("exit after 01:00 (going home) does not count as Total Outside", () => {
    const { workStart, workEnd } = getAttendanceWorkHoursBounds(WORK_DATE, TZ);
    const start = zonedDateTime("2026-10-28", "01:10", TZ);
    const end = zonedDateTime("2026-10-28", "01:40", TZ);
    assert.equal(overlapMinutes(start, end, workStart, workEnd), 0);
    assert.equal(
        sumWorkHoursOutsideMinutes([{ startTime: start, endTime: end }], end, workStart, workEnd),
        0
    );
});

test("open break that crosses 01:00 is clipped at work end", () => {
    const { workStart, workEnd } = getAttendanceWorkHoursBounds(WORK_DATE, TZ);
    const start = zonedDateTime("2026-10-28", "00:50", TZ);
    const now = zonedDateTime("2026-10-28", "01:30", TZ);
    assert.equal(
        sumWorkHoursOutsideMinutes([{ startTime: start, endTime: null }], now, workStart, workEnd),
        10
    );
});

test("closed interval spanning 01:00 only counts until 01:00", () => {
    const { workStart, workEnd } = getAttendanceWorkHoursBounds(WORK_DATE, TZ);
    const start = zonedDateTime("2026-10-28", "00:45", TZ);
    const end = zonedDateTime("2026-10-28", "01:20", TZ);
    assert.equal(
        sumWorkHoursOutsideMinutes([{ startTime: start, endTime: end }], end, workStart, workEnd),
        15
    );
});
