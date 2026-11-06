import assert from "node:assert/strict";
import test from "node:test";
import {
    ASSIGNMENT_TIMEZONE,
    arrivedSince,
    chooseAssignmentPool,
    assignmentWasAfterHours,
    isAfterHoursAssignment,
    nightAcceptanceDeadline,
    NIGHT_HOLD_UNTIL_OFFICE,
    startOfShipmentDay,
    zonedDateTime,
} from "./helpers.js";

test("queue hours follow Yerevan, not Los Angeles", () => {
    assert.equal(ASSIGNMENT_TIMEZONE, "Asia/Yerevan");
    const morning = zonedDateTime("2026-11-04", "05:09", "Asia/Yerevan");
    assert.equal(isAfterHoursAssignment(morning, "Asia/Yerevan"), true);
    assert.equal(isAfterHoursAssignment(morning, "America/Los_Angeles"), false);
    assert.equal(isAfterHoursAssignment(zonedDateTime("2026-11-04", "16:59", "Asia/Yerevan"), "Asia/Yerevan"), true);
    assert.equal(isAfterHoursAssignment(zonedDateTime("2026-11-04", "17:00", "Asia/Yerevan"), "Asia/Yerevan"), false);
});

test("after 01:00 the whole roster is used, even if somebody is still in office", () => {
    assert.equal(
        chooseAssignmentPool({ afterHours: true, linkedCount: 8, inOfficeCount: 1 }),
        "after_hours"
    );
    assert.equal(
        chooseAssignmentPool({ afterHours: false, linkedCount: 8, inOfficeCount: 1 }),
        "in_office"
    );
    assert.equal(
        chooseAssignmentPool({ afterHours: false, linkedCount: 8, inOfficeCount: 0 }),
        "none"
    );
});

const tz = "America/Los_Angeles";

test("night handoff stays a night shipment when the email time is office hours", () => {
    const emailAtOffice = zonedDateTime("2026-11-04", "18:00", "Asia/Yerevan");
    const handedAtNight = zonedDateTime("2026-11-05", "05:10", "Asia/Yerevan");
    assert.equal(
        assignmentWasAfterHours(
            { assignedAt: handedAtNight, receivedAt: emailAtOffice },
            "Asia/Yerevan"
        ),
        true
    );
    assert.equal(isAfterHoursAssignment(emailAtOffice, "Asia/Yerevan"), false);
});

test("after 01:00 and before 17:00 is after-hours assignment", () => {
    assert.equal(isAfterHoursAssignment(zonedDateTime("2026-11-03", "00:59", tz), tz), false);
    assert.equal(isAfterHoursAssignment(zonedDateTime("2026-11-03", "01:00", tz), tz), true);
    assert.equal(isAfterHoursAssignment(zonedDateTime("2026-11-03", "12:00", tz), tz), true);
    assert.equal(isAfterHoursAssignment(zonedDateTime("2026-11-03", "16:59", tz), tz), true);
    assert.equal(isAfterHoursAssignment(zonedDateTime("2026-11-03", "17:00", tz), tz), false);
    assert.equal(isAfterHoursAssignment(zonedDateTime("2026-11-03", "22:30", tz), tz), false);
});

test("night shipment waits for office check-in, then 30 minutes", () => {
    const now = zonedDateTime("2026-11-03", "02:15", tz);
    const nightArrival = zonedDateTime("2026-11-03", "02:10", tz);
    const dayArrival = zonedDateTime("2026-11-02", "18:00", tz);
    assert.equal(
        nightAcceptanceDeadline({
            arrivedAt: nightArrival,
            now,
            assigneeInOffice: false,
            timezone: tz,
        }).getTime(),
        NIGHT_HOLD_UNTIL_OFFICE.getTime()
    );
    const inOffice = nightAcceptanceDeadline({
        arrivedAt: nightArrival,
        now,
        assigneeInOffice: true,
        timezone: tz,
    });
    assert.equal(inOffice.getTime() - now.getTime(), 30 * 60_000);
    const day = nightAcceptanceDeadline({
        arrivedAt: dayArrival,
        now,
        assigneeInOffice: false,
        timezone: tz,
    });
    assert.equal(day.getTime() - now.getTime(), 15 * 60_000);
});

test("shipment day starts at 01:00 Yerevan, not midnight UTC or LA", () => {
    const afternoon = zonedDateTime("2026-11-06", "15:35", ASSIGNMENT_TIMEZONE);
    const start = startOfShipmentDay(afternoon, ASSIGNMENT_TIMEZONE);
    assert.equal(start.toISOString(), zonedDateTime("2026-11-06", "01:00", ASSIGNMENT_TIMEZONE).toISOString());

    const justBefore = zonedDateTime("2026-11-06", "00:59", ASSIGNMENT_TIMEZONE);
    assert.equal(
        startOfShipmentDay(justBefore, ASSIGNMENT_TIMEZONE).toISOString(),
        zonedDateTime("2026-11-05", "01:00", ASSIGNMENT_TIMEZONE).toISOString()
    );

    const exactlyOne = zonedDateTime("2026-11-06", "01:00", ASSIGNMENT_TIMEZONE);
    assert.equal(
        startOfShipmentDay(exactlyOne, ASSIGNMENT_TIMEZONE).toISOString(),
        zonedDateTime("2026-11-06", "01:00", ASSIGNMENT_TIMEZONE).toISOString()
    );

    // Old bug used server-local midnight (UTC on Contabo) → 04:00 Yerevan and undercounted.
    const utcMidnight = new Date("2026-11-06T00:00:00.000Z");
    assert.ok(start.getTime() < utcMidnight.getTime());
    assert.equal(start.toISOString(), "2026-11-05T21:00:00.000Z");
});

test("arrivedSince prefers receivedAt and falls back to createdAt", () => {
    const since = zonedDateTime("2026-11-06", "01:00", ASSIGNMENT_TIMEZONE);
    assert.deepEqual(arrivedSince(since), {
        OR: [
            { receivedAt: { gte: since } },
            { AND: [{ receivedAt: null }, { createdAt: { gte: since } }] },
        ],
    });
});
