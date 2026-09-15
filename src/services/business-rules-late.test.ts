import test from "node:test";
import assert from "node:assert/strict";
import { businessRulesEngine } from "./business-rules.engine.js";
import {
  ATTENDANCE_DAY_START,
  ATTENDANCE_GRACE_MINUTES,
  getAttendanceDayBounds,
  zonedDateTime,
} from "../utils/helpers.js";

const TZ = "America/Los_Angeles";
const WORK_DATE = "2026-09-15";

test("constants: work starts 17:00 with 15 minute grace", () => {
  assert.equal(ATTENDANCE_DAY_START, "17:00");
  assert.equal(ATTENDANCE_GRACE_MINUTES, 15);
});

test("late after 17:15 — on-time and late boundary cases", () => {
  const { scheduledStart } = getAttendanceDayBounds(WORK_DATE, TZ);
  assert.equal(
    scheduledStart.toLocaleString("en-GB", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
    "17:00"
  );

  const cases: Array<{ time: string; late: boolean; minutes?: number }> = [
    { time: "16:59", late: false },
    { time: "17:00", late: false },
    { time: "17:15", late: false },
    { time: "17:16", late: true, minutes: 1 },
    { time: "17:30", late: true, minutes: 15 },
    { time: "17:35", late: true, minutes: 20 },
  ];

  for (const c of cases) {
    const firstEntry = zonedDateTime(WORK_DATE, c.time, TZ);
    const result = businessRulesEngine.calculateLateStatus(
      firstEntry,
      scheduledStart,
      ATTENDANCE_GRACE_MINUTES
    );
    assert.equal(result.late, c.late, `${c.time} late flag`);
    if (c.late) {
      assert.equal(result.lateMinutes, c.minutes, `${c.time} late minutes`);
    } else {
      assert.equal(result.lateMinutes, 0, `${c.time} late minutes`);
    }
  }
});
