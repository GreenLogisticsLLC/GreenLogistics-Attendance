import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../../../config/database.js";
import { brokerShipmentStatsService } from "./broker-shipment-stats.service.js";

test("team lead broker totals split new, other, accept, and new without accept", async () => {
    const stamp = Date.now();
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
            username: `lead-stats-${stamp}`,
            passwordHash: "x",
            firstName: "Alen",
            lastName: "Young",
            email: `lead-stats-${stamp}@example.com`,
            roleId: leadRole.roleId,
        },
    });
    const andy = await prisma.user.create({
        data: {
            username: `andy-stats-${stamp}`,
            passwordHash: "x",
            firstName: "Andy",
            lastName: "Murrey",
            email: `andy-stats-${stamp}@example.com`,
            roleId: brokerRole.roleId,
            teamLeadId: lead.userId,
        },
    });
    const lia = await prisma.user.create({
        data: {
            username: `lia-stats-${stamp}`,
            passwordHash: "x",
            firstName: "Lia",
            lastName: "Torres",
            email: `lia-stats-${stamp}@example.com`,
            roleId: brokerRole.roleId,
            teamLeadId: lead.userId,
        },
    });
    const acceptedNew = await prisma.shipmentLead.create({
        data: {
            source: "TEST",
            shipmentTitle: `Accepted new ${stamp}`,
            assignedBrokerId: andy.userId,
            acceptedAt: new Date(),
            status: "WORKING",
        },
    });
    const passedNew = await prisma.shipmentLead.create({
        data: {
            source: "TEST",
            shipmentTitle: `Passed new ${stamp}`,
            assignedBrokerId: lia.userId,
            isReassignment: true,
            wasEverReassigned: true,
            acceptedAt: new Date(),
            status: "WORKING",
        },
    });
    const waitingNew = await prisma.shipmentLead.create({
        data: {
            source: "TEST",
            shipmentTitle: `Waiting new ${stamp}`,
            assignedBrokerId: lia.userId,
            status: "AWAITING_ACCEPTANCE",
        },
    });
    const leadIds = [acceptedNew.shipmentLeadId, passedNew.shipmentLeadId, waitingNew.shipmentLeadId];

    async function assign(shipmentLeadId: string, userId: string, kind: "ASSIGNED" | "REASSIGNED", from?: string) {
        await prisma.assignmentLog.create({
            data: {
                shipmentLeadId,
                assignedUserId: userId,
                eventType: kind,
                message: kind,
            },
        });
        await prisma.domainEvent.create({
            data: {
                shipmentLeadId,
                eventType: "BROKER_ASSIGNED",
                title: "Assigned",
                actorUserId: userId,
                payloadJson: JSON.stringify({ brokerId: userId, reassignFrom: from || null }),
            },
        });
    }

    await assign(acceptedNew.shipmentLeadId, andy.userId, "ASSIGNED");
    await assign(passedNew.shipmentLeadId, andy.userId, "ASSIGNED");
    await assign(passedNew.shipmentLeadId, lia.userId, "REASSIGNED", andy.userId);
    await assign(waitingNew.shipmentLeadId, lia.userId, "ASSIGNED");

    try {
        const data = await brokerShipmentStatsService.forTeamLead(lead.userId);
        const byName = Object.fromEntries(data.rows.map((row) => [row.name, row]));
        assert.equal(byName["Andy Murrey"].newReceived, 2);
        assert.equal(byName["Andy Murrey"].otherReceived, 0);
        assert.equal(byName["Andy Murrey"].accepted, 1);
        assert.equal(byName["Andy Murrey"].newNotAccepted, 1);
        assert.equal(byName["Lia Torres"].newReceived, 1);
        assert.equal(byName["Lia Torres"].otherReceived, 1);
        assert.equal(byName["Lia Torres"].accepted, 1);
        assert.equal(byName["Lia Torres"].newNotAccepted, 1);
    } finally {
        await prisma.domainEvent.deleteMany({ where: { shipmentLeadId: { in: leadIds } } });
        await prisma.assignmentLog.deleteMany({ where: { shipmentLeadId: { in: leadIds } } });
        await prisma.shipmentLead.deleteMany({ where: { shipmentLeadId: { in: leadIds } } });
        await prisma.user.deleteMany({
            where: { userId: { in: [lead.userId, andy.userId, lia.userId] } },
        });
    }
});
