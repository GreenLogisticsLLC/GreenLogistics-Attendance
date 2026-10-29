import test from "node:test";
import assert from "node:assert/strict";
import {
    ATTENDANCE_DAY_START,
    ATTENDANCE_DISPLAY_OFFSET_MS,
    ATTENDANCE_WORK_END,
    currentOutsideNowMinutes,
    getAttendanceWorkHoursBounds,
    isGoingHomeExit,
    overlapMinutes,
    sumAttendanceOutsideMinutes,
    sumWorkHoursOutsideMinutes,
    zonedDateTime,
} from "../utils/helpers.js";

/** Access-control stamp that displays as `time` on the office clock. */
function stamped(workDate: string, time: string) {
    return new Date(zonedDateTime(workDate, time, TZ).getTime() + ATTENDANCE_DISPLAY_OFFSET_MS);
}

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

test("access-control +1h stamp still counts Total Outside on the office clock", () => {
    const { workStart, workEnd } = getAttendanceWorkHoursBounds(WORK_DATE, TZ);
    const now = zonedDateTime(WORK_DATE, "17:45", TZ);
    const storedStart = stamped(WORK_DATE, "17:20");
    // Raw stamp is 18:20 — without the office-clock shift this would be 0 vs now 17:45.
    assert.equal(
        sumWorkHoursOutsideMinutes(
            [{ startTime: storedStart, endTime: null }],
            now,
            workStart,
            workEnd
        ),
        0
    );
    assert.equal(
        sumAttendanceOutsideMinutes(
            [{ startTime: storedStart, endTime: null }],
            now,
            workStart,
            workEnd
        ),
        25
    );
});

test("Outside Now ticks immediately after an exit, even before 17:00", () => {
    const { workStart, workEnd } = getAttendanceWorkHoursBounds(WORK_DATE, TZ);
    const now = zonedDateTime(WORK_DATE, "06:45", TZ);
    const storedStart = stamped(WORK_DATE, "05:35");
    assert.equal(currentOutsideNowMinutes(storedStart, now, workEnd), 70);
    assert.equal(
        sumAttendanceOutsideMinutes(
            [{ startTime: storedStart, endTime: null }],
            now,
            workStart,
            workEnd
        ),
        0
    );
});

test("open morning break that continues past 17:00 counts Total Outside from 17:00", () => {
    const { workStart, workEnd } = getAttendanceWorkHoursBounds(WORK_DATE, TZ);
    const now = zonedDateTime(WORK_DATE, "17:20", TZ);
    const storedStart = stamped(WORK_DATE, "16:50");
    assert.equal(
        sumAttendanceOutsideMinutes(
            [{ startTime: storedStart, endTime: null }],
            now,
            workStart,
            workEnd
        ),
        20
    );
    assert.equal(currentOutsideNowMinutes(storedStart, now, workEnd), 30);
});

test("EXIT after 01:00 office clock is going home", () => {
    const { workEnd } = getAttendanceWorkHoursBounds(WORK_DATE, TZ);
    assert.equal(isGoingHomeExit(stamped("2026-10-28", "01:00"), workEnd), true);
    assert.equal(isGoingHomeExit(stamped("2026-10-28", "00:50"), workEnd), false);
    assert.equal(isGoingHomeExit(stamped(WORK_DATE, "18:00"), workEnd), false);
});

test("Outside Now freezes at 01:00", () => {
    const { workEnd } = getAttendanceWorkHoursBounds(WORK_DATE, TZ);
    const storedStart = stamped("2026-10-28", "00:50");
    const afterClose = zonedDateTime("2026-10-28", "01:30", TZ);
    assert.equal(currentOutsideNowMinutes(storedStart, afterClose, workEnd), 10);
});
