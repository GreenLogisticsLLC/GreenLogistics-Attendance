import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../config/database.js";
import { listTeamBrokerEmployeeIds } from "../auth/team-scope.js";
import { reportService } from "./report.service.js";

test("a team lead journal includes only that lead's brokers", async () => {
    const stamp = Date.now();
    const shift = await prisma.shift.create({
        data: { shiftName: `journal-${stamp}`, startTime: "17:00", endTime: "01:00" },
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
    const alen = await prisma.user.create({
        data: {
            username: `alen-journal-${stamp}`,
            passwordHash: "x",
            firstName: "Alen",
            lastName: "Young",
            email: `alen-journal-${stamp}@example.com`,
            roleId: leadRole.roleId,
        },
    });
    const carl = await prisma.user.create({
        data: {
            username: `carl-journal-${stamp}`,
            passwordHash: "x",
            firstName: "Carl",
            lastName: "Anderson",
            email: `carl-journal-${stamp}@example.com`,
            roleId: leadRole.roleId,
        },
    });
    const alenBrokerBadge = await prisma.employee.create({
        data: {
            employeeNumber: `AJ${stamp}`,
            firstName: "Rio",
            lastName: "Clark",
            department: "Team Alen Young",
            cardNumber: `card-alen-${stamp}`,
            shiftId: shift.shiftId,
        },
    });
    const carlBrokerBadge = await prisma.employee.create({
        data: {
            employeeNumber: `CJ${stamp}`,
            firstName: "Finn",
            lastName: "Anderson",
            department: "Team Carl Anderson",
            cardNumber: `card-carl-${stamp}`,
            shiftId: shift.shiftId,
        },
    });
    const alenBroker = await prisma.user.create({
        data: {
            username: `rio-journal-${stamp}`,
            passwordHash: "x",
            firstName: "Rio",
            lastName: "Clark",
            email: `rio-journal-${stamp}@example.com`,
            roleId: brokerRole.roleId,
            teamLeadId: alen.userId,
            employeeId: alenBrokerBadge.employeeId,
        },
    });
    const carlBroker = await prisma.user.create({
        data: {
            username: `finn-journal-${stamp}`,
            passwordHash: "x",
            firstName: "Finn",
            lastName: "Anderson",
            email: `finn-journal-${stamp}@example.com`,
            roleId: brokerRole.roleId,
            teamLeadId: carl.userId,
            employeeId: carlBrokerBadge.employeeId,
        },
    });
    const workDate = "2026-11-02";
    const start = new Date("2026-11-03T01:00:00.000Z");
    const end = new Date("2026-11-03T09:00:00.000Z");
    await prisma.attendanceSession.createMany({
        data: [
            {
                employeeId: alenBrokerBadge.employeeId,
                shiftId: shift.shiftId,
                workDate,
                scheduledStart: start,
                scheduledEnd: end,
                firstEntry: new Date("2026-11-03T01:16:00.000Z"),
                lastExit: new Date("2026-11-03T08:30:00.000Z"),
                currentStatus: "OUTSIDE_OFFICE",
                exitCount: 1,
            },
            {
                employeeId: carlBrokerBadge.employeeId,
                shiftId: shift.shiftId,
                workDate,
                scheduledStart: start,
                scheduledEnd: end,
                firstEntry: new Date("2026-11-03T01:20:00.000Z"),
                lastExit: new Date("2026-11-03T08:00:00.000Z"),
                currentStatus: "OUTSIDE_OFFICE",
                exitCount: 2,
            },
        ],
    });

    try {
        const allowed = await listTeamBrokerEmployeeIds(alen.userId);
        assert.ok(allowed.includes(alenBrokerBadge.employeeId));
        assert.equal(allowed.includes(carlBrokerBadge.employeeId), false);

        const report = await reportService.getPeriodReport(workDate, workDate, {
            employeeIds: allowed,
        });
        const names = report.rows.map((row) => row.employeeName);
        assert.deepEqual(names, ["Rio Clark"]);
        assert.equal(report.summary.totalSessions, 1);
    } finally {
        await prisma.attendanceSession.deleteMany({
            where: { employeeId: { in: [alenBrokerBadge.employeeId, carlBrokerBadge.employeeId] } },
        });
        await prisma.user.deleteMany({
            where: { userId: { in: [alenBroker.userId, carlBroker.userId, alen.userId, carl.userId] } },
        });
        await prisma.employee.deleteMany({
            where: { employeeId: { in: [alenBrokerBadge.employeeId, carlBrokerBadge.employeeId] } },
        });
        await prisma.shift.delete({ where: { shiftId: shift.shiftId } });
    }
});
