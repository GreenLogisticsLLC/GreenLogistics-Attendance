import assert from "node:assert/strict";
import test from "node:test";
import {
    isMailboxRole,
    mailboxAccountWhere,
    normalizeLoginHint,
} from "./broker-gmail-oauth.service.js";

test("brokers and team leads can connect a mailbox", () => {
    assert.equal(isMailboxRole("Broker"), true);
    assert.equal(isMailboxRole("Team Lead"), true);
    assert.equal(isMailboxRole("Owner"), false);
    assert.equal(isMailboxRole("Manager"), false);
    assert.equal(isMailboxRole(""), false);
});

test("login hint keeps a real email and drops anything else", () => {
    assert.equal(normalizeLoginHint("  Allen@GreenGroupLogistics.com "), "allen@greengrouplogistics.com");
    assert.equal(normalizeLoginHint("not an email"), "");
    assert.equal(normalizeLoginHint(""), "");
});

test("mailbox list includes brokers and team leads without filtering attendance badge status", () => {
    const where = mailboxAccountWhere(null);
    const role = where.role as { roleName: { in: string[] } };
    assert.deepEqual(role.roleName.in.sort(), ["Broker", "Team Lead"]);
    assert.equal(where.isActive, true);
    // Missing / inactive Attendance badges must still appear so Owner can Connect Gmail.
    assert.equal(where.OR, undefined);
    assert.equal(where.employeeId, undefined);
    const scoped = mailboxAccountWhere(["alen-id"]);
    assert.deepEqual(scoped.userId, { in: ["alen-id"] });
    assert.deepEqual(mailboxAccountWhere([]).userId, { in: ["__none__"] });
});
