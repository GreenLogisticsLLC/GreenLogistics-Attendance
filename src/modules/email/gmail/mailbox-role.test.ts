import assert from "node:assert/strict";
import test from "node:test";
import {
    isMailboxListRole,
    isMailboxRole,
    mailboxAccountWhere,
    mailboxListRoles,
    normalizeLoginHint,
    normalizeMailboxRole,
} from "./broker-gmail-oauth.service.js";

test("brokers and team leads can connect a mailbox", () => {
    assert.equal(isMailboxRole("Broker"), true);
    assert.equal(isMailboxRole("Team Lead"), true);
    assert.equal(isMailboxRole("Owner"), false);
    assert.equal(isMailboxRole("Manager"), false);
    assert.equal(isMailboxRole(""), false);
});

test("managers appear in the Email Accounts person list but need a mailbox role", () => {
    assert.equal(isMailboxListRole("Manager"), true);
    assert.equal(isMailboxListRole("Broker"), true);
    assert.equal(isMailboxListRole("Owner"), false);
    assert.deepEqual(mailboxListRoles().sort(), ["Broker", "Manager", "Team Lead"]);
});

test("mailbox role picker normalizes Broker / Team Lead", () => {
    assert.equal(normalizeMailboxRole("Broker"), "Broker");
    assert.equal(normalizeMailboxRole("Team Lead"), "Team Lead");
    assert.equal(normalizeMailboxRole("TeamLead"), "Team Lead");
    assert.equal(normalizeMailboxRole("Manager"), "");
});

test("login hint keeps a real email and drops anything else", () => {
    assert.equal(normalizeLoginHint("  Allen@GreenGroupLogistics.com "), "allen@greengrouplogistics.com");
    assert.equal(normalizeLoginHint("not an email"), "");
    assert.equal(normalizeLoginHint(""), "");
});

test("mailbox list includes managers so Owner can pick status then connect", () => {
    const where = mailboxAccountWhere(null);
    const role = where.role as { roleName: { in: string[] } };
    assert.deepEqual(role.roleName.in.sort(), ["Broker", "Manager", "Team Lead"]);
    assert.equal(where.isActive, true);
    assert.equal(where.OR, undefined);
    assert.equal(where.employeeId, undefined);
    const scoped = mailboxAccountWhere(["alen-id"]);
    assert.deepEqual(scoped.userId, { in: ["alen-id"] });
    assert.deepEqual(mailboxAccountWhere([]).userId, { in: ["__none__"] });
});
