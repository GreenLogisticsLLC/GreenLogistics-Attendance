import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../../config/database.js";
import { SHIPMENTS_FROM } from "../../services/shipment-cutoff.js";
import { awaitingAcceptWhere, unassignedShipmentWhere } from "./unassigned-where.js";

test("unassigned count includes shipments held by brokers who are not eligible", async () => {
    const stamp = Date.now();
    const broker = await prisma.user.create({
        data: {
            username: `unassigned-broker-${stamp}`,
            passwordHash: "x",
            firstName: "Leah",
            lastName: "Romano",
            email: `unassigned-broker-${stamp}@example.com`,
            role: {
                connectOrCreate: {
                    where: { roleName: "Broker" },
                    create: { roleName: "Broker", description: "Broker" },
                },
            },
        },
    });
    const receivedAt = new Date(SHIPMENTS_FROM.getTime() + 60 * 60 * 1000);
    const parked = await prisma.shipmentLead.create({
        data: {
            source: "TEST",
            shipmentTitle: `Parked ${stamp}`,
            status: "NEW",
            receivedAt,
            acceptedAt: null,
        },
    });
    const waitingOnOutBroker = await prisma.shipmentLead.create({
        data: {
            source: "TEST",
            shipmentTitle: `Waiting ${stamp}`,
            status: "AWAITING_ACCEPTANCE",
            assignedBrokerId: broker.userId,
            receivedAt,
            acceptedAt: null,
        },
    });
    const old = await prisma.shipmentLead.create({
        data: {
            source: "TEST",
            shipmentTitle: `Old ${stamp}`,
            status: "UNASSIGNED",
            receivedAt: new Date(SHIPMENTS_FROM.getTime() - 60 * 60 * 1000),
            acceptedAt: null,
        },
    });
    const ids = [parked.shipmentLeadId, waitingOnOutBroker.shipmentLeadId, old.shipmentLeadId];

    try {
        const nobodyEligible = await prisma.shipmentLead.count({
            where: {
                shipmentLeadId: { in: ids },
                AND: [unassignedShipmentWhere([])],
            },
        });
        assert.equal(nobodyEligible, 2);

        const brokerEligible = await prisma.shipmentLead.count({
            where: {
                shipmentLeadId: { in: ids },
                AND: [unassignedShipmentWhere([broker.userId])],
            },
        });
        assert.equal(brokerEligible, 1);

        const awaiting = await prisma.shipmentLead.count({
            where: {
                shipmentLeadId: { in: ids },
                AND: [awaitingAcceptWhere([broker.userId])],
            },
        });
        assert.equal(awaiting, 1);
        const awaitingNone = await prisma.shipmentLead.count({
            where: {
                shipmentLeadId: { in: ids },
                AND: [awaitingAcceptWhere([])],
            },
        });
        assert.equal(awaitingNone, 0);
    } finally {
        await prisma.shipmentLead.deleteMany({ where: { shipmentLeadId: { in: ids } } });
        await prisma.user.delete({ where: { userId: broker.userId } });
    }
});
