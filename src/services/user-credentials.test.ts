import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { prisma } from "../config/database.js";
import { usersService } from "./users.service.js";

test("Owner can set username + password; plaintext password is never returned", async () => {
    const stamp = Date.now();
    const ownerRole = await prisma.role.upsert({
        where: { roleName: "Owner" },
        update: {},
        create: { roleName: "Owner", description: "Owner" },
    });
    const brokerRole = await prisma.role.upsert({
        where: { roleName: "Broker" },
        update: {},
        create: { roleName: "Broker", description: "Broker" },
    });
    const owner = await prisma.user.create({
        data: {
            username: `owner-cred-${stamp}`,
            passwordHash: await bcrypt.hash("old-owner-pass", 10),
            firstName: "Main",
            lastName: "Owner",
            email: `owner-cred-${stamp}@example.com`,
            roleId: ownerRole.roleId,
        },
    });
    const broker = await prisma.user.create({
        data: {
            username: `broker-cred-${stamp}`,
            passwordHash: await bcrypt.hash("old-broker-pass", 10),
            firstName: "Ann",
            lastName: "Broker",
            email: `broker-cred-${stamp}@example.com`,
            roleId: brokerRole.roleId,
            teamLeadId: owner.userId,
            isActive: false,
        },
    });

    const actor = { userId: owner.userId, role: "Owner" };
    const result = await usersService.setUserCredentials(actor, broker.userId, {
        username: `broker-new-${stamp}`,
        password: "TempPass99",
        isActive: true,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.username, `broker-new-${stamp}`);
    assert.equal(result.data.isActive, true);
    assert.ok(!JSON.stringify(result.data).includes("TempPass99"));
    assert.ok(!("password" in result.data));
    assert.ok(!("passwordHash" in result.data));

    const row = await prisma.user.findUnique({ where: { userId: broker.userId } });
    assert.ok(row);
    assert.equal(row!.username, `broker-new-${stamp}`);
    assert.equal(row!.isActive, true);
    assert.equal(await bcrypt.compare("TempPass99", row!.passwordHash), true);
    assert.equal(await bcrypt.compare("old-broker-pass", row!.passwordHash), false);

    await prisma.user.deleteMany({
        where: { userId: { in: [broker.userId, owner.userId] } },
    });
});

test("Manager cannot change Owner credentials", async () => {
    const stamp = Date.now();
    const ownerRole = await prisma.role.upsert({
        where: { roleName: "Owner" },
        update: {},
        create: { roleName: "Owner", description: "Owner" },
    });
    const managerRole = await prisma.role.upsert({
        where: { roleName: "Manager" },
        update: {},
        create: { roleName: "Manager", description: "Manager" },
    });
    const owner = await prisma.user.create({
        data: {
            username: `owner-prot-${stamp}`,
            passwordHash: "x",
            firstName: "Own",
            lastName: "Er",
            email: `owner-prot-${stamp}@example.com`,
            roleId: ownerRole.roleId,
        },
    });
    const manager = await prisma.user.create({
        data: {
            username: `mgr-prot-${stamp}`,
            passwordHash: "x",
            firstName: "Man",
            lastName: "Ager",
            email: `mgr-prot-${stamp}@example.com`,
            roleId: managerRole.roleId,
        },
    });

    const result = await usersService.setUserCredentials(
        { userId: manager.userId, role: "Manager" },
        owner.userId,
        { password: "ShouldNotWork1" }
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 403);

    await prisma.user.deleteMany({
        where: { userId: { in: [owner.userId, manager.userId] } },
    });
});
