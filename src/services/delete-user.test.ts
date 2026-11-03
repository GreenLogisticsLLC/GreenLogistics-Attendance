import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../config/database.js";
import { usersService } from "./users.service.js";

test("delete removes a broker blocked by a customer, and remove keeps the account editable", async () => {
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
            username: `owner-deluser-${stamp}`,
            passwordHash: "x",
            firstName: "Main",
            lastName: "Account",
            email: `owner-deluser-${stamp}@example.com`,
            roleId: ownerRole.roleId,
        },
    });
    const broker = await prisma.user.create({
        data: {
            username: `broker-deluser-${stamp}`,
            passwordHash: "x",
            firstName: "Kate",
            lastName: "Williams",
            email: `kate-deluser-${stamp}@example.com`,
            roleId: brokerRole.roleId,
            teamLeadId: owner.userId,
        },
    });
    const actor = { userId: owner.userId, role: "Owner" };
    const customer = await prisma.directCustomer.create({
        data: { companyName: `Delete Block ${stamp}`, createdByUserId: broker.userId },
    });
    const lead = await prisma.shipmentLead.create({
        data: {
            source: "TEST",
            shipmentTitle: `Delete lead ${stamp}`,
            assignedBrokerId: broker.userId,
            status: "ASSIGNED",
        },
    });
    await prisma.domainEvent.create({
        data: {
            shipmentLeadId: lead.shipmentLeadId,
            eventType: "TEST",
            title: "test",
        },
    });
    await prisma.auditLog.create({
        data: {
            userId: broker.userId,
            module: "TEST",
            action: "TEST",
            entityName: "User",
        },
    });
    const queue = await prisma.assignmentQueueState.findUnique({ where: { queueKey: "brokers" } });
    const originalQueue = queue?.orderedUserIdsJson || "[]";
    const originalIndex = queue?.nextIndex || 0;
    const queued = JSON.parse(originalQueue);
    queued.push(broker.userId);
    await prisma.assignmentQueueState.upsert({
        where: { queueKey: "brokers" },
        update: { orderedUserIdsJson: JSON.stringify(queued) },
        create: { queueKey: "brokers", orderedUserIdsJson: JSON.stringify(queued), nextIndex: 0 },
    });

    try {
        const removed = await usersService.removeUser(actor, broker.userId);
        assert.equal(removed.ok, true);
        const afterRemove = await prisma.user.findUnique({ where: { userId: broker.userId } });
        assert.equal(afterRemove?.isActive, false);
        assert.equal(afterRemove?.teamLeadId, null);
        assert.ok(await prisma.shipmentLead.findUnique({ where: { shipmentLeadId: lead.shipmentLeadId } }));

        const deleted = await usersService.deleteUser(actor, broker.userId);
        assert.equal(deleted.ok, true, deleted.ok ? "" : deleted.message);
        assert.equal(await prisma.user.findUnique({ where: { userId: broker.userId } }), null);
        assert.equal(
            await prisma.shipmentLead.findUnique({ where: { shipmentLeadId: lead.shipmentLeadId } }),
            null
        );
        const kept = await prisma.directCustomer.findUnique({ where: { customerId: customer.customerId } });
        assert.equal(kept?.createdByUserId, owner.userId);
        const afterQueue = await prisma.assignmentQueueState.findUnique({ where: { queueKey: "brokers" } });
        assert.equal(String(afterQueue?.orderedUserIdsJson || "").includes(broker.userId), false);
    } finally {
        await prisma.assignmentQueueState.upsert({
            where: { queueKey: "brokers" },
            update: { orderedUserIdsJson: originalQueue, nextIndex: originalIndex },
            create: { queueKey: "brokers", orderedUserIdsJson: originalQueue, nextIndex: originalIndex },
        });
        await prisma.directCustomer.deleteMany({ where: { customerId: customer.customerId } });
        await prisma.domainEvent.deleteMany({ where: { shipmentLeadId: lead.shipmentLeadId } });
        await prisma.shipmentLead.deleteMany({ where: { shipmentLeadId: lead.shipmentLeadId } });
        await prisma.auditLog.deleteMany({ where: { userId: broker.userId } });
        await prisma.user.deleteMany({ where: { userId: { in: [broker.userId, owner.userId] } } });
    }
});
