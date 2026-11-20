import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../config/database.js";
import { usersService } from "./users.service.js";

test("Owner can demote Team Lead to Manager without naming a transfer target", async () => {
    const stamp = Date.now();
    const ownerRole = await prisma.role.upsert({
        where: { roleName: "Owner" },
        update: {},
        create: { roleName: "Owner", description: "Owner" },
    });
    const tlRole = await prisma.role.upsert({
        where: { roleName: "Team Lead" },
        update: {},
        create: { roleName: "Team Lead", description: "Team Lead" },
    });
    await prisma.role.upsert({
        where: { roleName: "Manager" },
        update: {},
        create: { roleName: "Manager", description: "Manager" },
    });
    const brokerRole = await prisma.role.upsert({
        where: { roleName: "Broker" },
        update: {},
        create: { roleName: "Broker", description: "Broker" },
    });

    const owner = await prisma.user.create({
        data: {
            username: `tl-leave-owner-${stamp}`,
            passwordHash: "x",
            firstName: "Own",
            lastName: "Er",
            email: `tl-leave-owner-${stamp}@example.com`,
            roleId: ownerRole.roleId,
        },
    });
    const lead = await prisma.user.create({
        data: {
            username: `tl-leave-lead-${stamp}`,
            passwordHash: "x",
            firstName: "Derek",
            lastName: "Test",
            email: `tl-leave-lead-${stamp}@example.com`,
            roleId: tlRole.roleId,
        },
    });
    const broker = await prisma.user.create({
        data: {
            username: `tl-leave-broker-${stamp}`,
            passwordHash: "x",
            firstName: "Bro",
            lastName: "Ker",
            email: `tl-leave-broker-${stamp}@example.com`,
            roleId: brokerRole.roleId,
            teamLeadId: lead.userId,
        },
    });

    const actor = { userId: owner.userId, role: "Owner" };

    // Role API path (Platform Users Save button).
    const roleResult = await usersService.updateUserRole(actor, lead.userId, "Manager", {
        transferTeamToUserId: null,
    });
    assert.equal(roleResult.ok, true);

    const afterRole = await prisma.user.findUnique({
        where: { userId: lead.userId },
        include: { role: true },
    });
    assert.equal(afterRole?.role.roleName, "Manager");

    const brokersAfterRole = await prisma.user.count({
        where: { teamLeadId: lead.userId, role: { roleName: "Broker" } },
    });
    assert.equal(brokersAfterRole, 0);

    const brokerRow = await prisma.user.findUnique({ where: { userId: broker.userId } });
    assert.equal(brokerRow?.teamLeadId, null);

    // Re-promote and leave via profile API (Change → Save path).
    await prisma.user.update({
        where: { userId: lead.userId },
        data: { roleId: tlRole.roleId },
    });
    await prisma.user.update({
        where: { userId: broker.userId },
        data: { teamLeadId: lead.userId },
    });

    const profile = await usersService.updateUserProfile(actor, lead.userId, {
        firstName: "Derek",
        lastName: "Test",
        role: "Manager",
        transferTeamToUserId: null,
    });
    assert.equal(profile.ok, true);

    const afterProfile = await prisma.user.findUnique({
        where: { userId: lead.userId },
        include: { role: true },
    });
    assert.equal(afterProfile?.role.roleName, "Manager");

    const brokersAfterProfile = await prisma.user.count({
        where: { teamLeadId: lead.userId, role: { roleName: "Broker" } },
    });
    assert.equal(brokersAfterProfile, 0);
});

test("Owner can demote Team Lead to Broker when a Team Lead is selected", async () => {
    const stamp = Date.now() + 1;
    const ownerRole = await prisma.role.upsert({
        where: { roleName: "Owner" },
        update: {},
        create: { roleName: "Owner", description: "Owner" },
    });
    const tlRole = await prisma.role.upsert({
        where: { roleName: "Team Lead" },
        update: {},
        create: { roleName: "Team Lead", description: "Team Lead" },
    });
    const brokerRole = await prisma.role.upsert({
        where: { roleName: "Broker" },
        update: {},
        create: { roleName: "Broker", description: "Broker" },
    });

    const owner = await prisma.user.create({
        data: {
            username: `tl-broker-owner-${stamp}`,
            passwordHash: "x",
            firstName: "Own",
            lastName: "Er",
            email: `tl-broker-owner-${stamp}@example.com`,
            roleId: ownerRole.roleId,
        },
    });
    const stayingLead = await prisma.user.create({
        data: {
            username: `tl-broker-stay-${stamp}`,
            passwordHash: "x",
            firstName: "Stay",
            lastName: "Lead",
            email: `tl-broker-stay-${stamp}@example.com`,
            roleId: tlRole.roleId,
        },
    });
    const leaving = await prisma.user.create({
        data: {
            username: `tl-broker-allen-${stamp}`,
            passwordHash: "x",
            firstName: "Allen",
            lastName: "Test",
            email: `tl-broker-allen-${stamp}@example.com`,
            roleId: tlRole.roleId,
        },
    });

    const actor = { userId: owner.userId, role: "Owner" };
    const roleResult = await usersService.updateUserRole(actor, leaving.userId, "Broker", {
        transferTeamToUserId: null,
    });
    assert.equal(roleResult.ok, true);

    const tlResult = await usersService.updateBrokerTeamLead(
        actor,
        leaving.userId,
        stayingLead.userId
    );
    assert.equal(tlResult.ok, true);

    const row = await prisma.user.findUnique({
        where: { userId: leaving.userId },
        include: { role: true },
    });
    assert.equal(row?.role.roleName, "Broker");
    assert.equal(row?.teamLeadId, stayingLead.userId);
});
