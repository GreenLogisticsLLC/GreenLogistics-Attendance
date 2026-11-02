import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../config/database.js";
import { listTeamBrokerIds, listTeamEmployeeIds } from "./team-scope.js";
import { departmentBelongsToLead } from "../services/user-attendance-link.service.js";
import { assignRioClarkToAlenYoung } from "../services/assign-rio-clark.js";

const alen = {
    firstName: "Alen",
    lastName: "Young",
    username: "alen",
    email: "alen@example.com",
};

test("department label Team Alen Young belongs to Alen", () => {
    assert.equal(departmentBelongsToLead("Team Alen Young", alen), true);
    assert.equal(departmentBelongsToLead("team allen young", alen), true);
    assert.equal(departmentBelongsToLead("Team Carl Anderson", alen), false);
    assert.equal(departmentBelongsToLead("Unassigned Team", alen), false);
});

test("Alen sees a badge labeled Team Alen Young even without teamLeadId", async () => {
    const stamp = Date.now();
    const shift = await prisma.shift.create({
        data: {
            shiftName: `flex-test-${stamp}`,
            startTime: "09:00",
            endTime: "18:00",
        },
    });
    const brokerRole = await prisma.role.upsert({
        where: { roleName: "Broker" },
        update: {},
        create: { roleName: "Broker", description: "Broker" },
    });
    const leadRole = await prisma.role.upsert({
        where: { roleName: "Team Lead" },
        update: {},
        create: { roleName: "Team Lead", description: "Team Lead" },
    });
    const lead = await prisma.user.create({
        data: {
            username: `alen-test-${stamp}`,
            passwordHash: "x",
            firstName: "Alen",
            lastName: "Young",
            email: `alen-test-${stamp}@example.com`,
            roleId: leadRole.roleId,
            isActive: true,
        },
    });
    const badge = await prisma.employee.create({
        data: {
            employeeNumber: `GL-T${stamp}`,
            firstName: "Rio",
            lastName: "Clark",
            department: "Team Alen Young",
            position: "Broker",
            cardNumber: `CARD-T${stamp}`,
            shiftId: shift.shiftId,
            status: "ACTIVE",
        },
    });
    const rio = await prisma.user.create({
        data: {
            username: `rio-test-${stamp}`,
            passwordHash: "x",
            firstName: "Rio",
            lastName: "Clark",
            email: `rio-test-${stamp}@example.com`,
            roleId: brokerRole.roleId,
            isActive: true,
            employeeId: badge.employeeId,
            teamLeadId: null,
        },
    });

    try {
        const employeeIds = await listTeamEmployeeIds(lead.userId);
        assert.ok(employeeIds.includes(badge.employeeId));
        const brokerIds = await listTeamBrokerIds(lead.userId);
        assert.ok(brokerIds.includes(rio.userId));
        assert.ok(brokerIds.includes(lead.userId));

        await prisma.setting.deleteMany({
            where: { category: "ops", settingKey: "rio_clark_team" },
        });
        await assignRioClarkToAlenYoung();
        const updated = await prisma.user.findUnique({ where: { userId: rio.userId } });
        assert.equal(updated?.teamLeadId, lead.userId);
        const updatedBadge = await prisma.employee.findUnique({
            where: { employeeId: badge.employeeId },
        });
        assert.equal(updatedBadge?.department, "Team Alen Young");
    } finally {
        await prisma.setting.deleteMany({
            where: { category: "ops", settingKey: "rio_clark_team" },
        });
        await prisma.user.deleteMany({
            where: { userId: { in: [rio.userId, lead.userId] } },
        });
        await prisma.employee.delete({ where: { employeeId: badge.employeeId } });
        await prisma.shift.delete({ where: { shiftId: shift.shiftId } });
    }
});
