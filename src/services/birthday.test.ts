import test from "node:test";
import assert from "node:assert/strict";
import { birthdayNoticeKey, isBirthdayOn, parseBirthDate, yerevanDate } from "./birthday.js";

test("Yerevan date is four hours ahead of UTC", () => {
    const parts = yerevanDate(new Date("2026-11-05T21:30:00.000Z"));
    assert.deepEqual(parts, { year: 2026, month: 11, day: 6 });
});

test("birthday matches the month and day in Yerevan", () => {
    const today = { year: 2026, month: 11, day: 6 };
    assert.equal(isBirthdayOn("1992-11-06", today), true);
    assert.equal(isBirthdayOn("1992-11-07", today), false);
    assert.equal(isBirthdayOn("", today), false);
});

test("Feb 29 is celebrated on Feb 28 when the year is not a leap year", () => {
    assert.equal(isBirthdayOn("2000-02-29", { year: 2026, month: 2, day: 28 }), true);
    assert.equal(isBirthdayOn("2000-02-29", { year: 2024, month: 2, day: 29 }), true);
    assert.equal(isBirthdayOn("2000-02-29", { year: 2024, month: 2, day: 28 }), false);
});

test("notice key is one per person per year", () => {
    assert.equal(birthdayNoticeKey("user-1", 2026), "user-1:2026");
});

test("birth date accepts a real day and rejects junk", () => {
    assert.deepEqual(parseBirthDate("1990-05-15"), { ok: true, value: "1990-05-15" });
    assert.deepEqual(parseBirthDate(""), { ok: true, value: null });
    assert.equal(parseBirthDate("1990-02-31").ok, false);
    assert.equal(parseBirthDate("tomorrow").ok, false);
});
