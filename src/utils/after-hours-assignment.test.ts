import assert from "node:assert/strict";
import test from "node:test";
import { isAfterHoursAssignment, zonedDateTime } from "./helpers.js";

const tz = "America/Los_Angeles";

test("after 01:00 and before 17:00 is after-hours assignment", () => {
    assert.equal(isAfterHoursAssignment(zonedDateTime("2026-11-03", "00:59", tz), tz), false);
    assert.equal(isAfterHoursAssignment(zonedDateTime("2026-11-03", "01:00", tz), tz), true);
    assert.equal(isAfterHoursAssignment(zonedDateTime("2026-11-03", "12:00", tz), tz), true);
    assert.equal(isAfterHoursAssignment(zonedDateTime("2026-11-03", "16:59", tz), tz), true);
    assert.equal(isAfterHoursAssignment(zonedDateTime("2026-11-03", "17:00", tz), tz), false);
    assert.equal(isAfterHoursAssignment(zonedDateTime("2026-11-03", "22:30", tz), tz), false);
});
