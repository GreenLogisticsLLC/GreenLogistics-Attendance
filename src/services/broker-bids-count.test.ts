import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../config/database.js";
import { crmService } from "../modules/crm/services/crm.service.js";

test("personal dashboard counts shipments that already have a bid", async () => {
    const role = await prisma.role.upsert({
        where: { roleName: "Broker" },
        update: {},
        create: { roleName: "Broker", description: "Broker" },
    });
    const stamp = Date.now();
    const user = await prisma.user.create({
        data: {
            username: `bid-count-${stamp}`,
            passwordHash: "x",
            firstName: "Leroy",
            lastName: "Patel",
            email: `bid-count-${stamp}@example.com`,
            roleId: role.roleId,
        },
    });
    const replied = await prisma.shipmentLead.create({
        data: {
            source: "test",
            shipmentTitle: "Bid then broker reply",
            status: "BROKER_REPLY",
            quoteSentAt: new Date(),
            assignedBrokerId: user.userId,
        },
    });
    const eventOnly = await prisma.shipmentLead.create({
        data: {
            source: "test",
            shipmentTitle: "Bid event only",
            status: "BROKER_REPLY",
            assignedBrokerId: user.userId,
        },
    });
    await prisma.domainEvent.create({
        data: {
            shipmentLeadId: eventOnly.shipmentLeadId,
            eventType: "BID_SUBMITTED",
            title: "Bid Submitted",
        },
    });
    try {
        const workspace = await crmService.getBrokerWorkspace(user.userId);
        assert.equal(workspace?.stats.quotesSent, 2);
    } finally {
        await prisma.shipmentLead.deleteMany({
            where: { shipmentLeadId: { in: [replied.shipmentLeadId, eventOnly.shipmentLeadId] } },
        });
        await prisma.user.delete({ where: { userId: user.userId } });
    }
});
