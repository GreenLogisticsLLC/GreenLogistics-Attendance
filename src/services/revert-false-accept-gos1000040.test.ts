import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../config/database.js";
import { revertFalseAcceptGos1000040 } from "./revert-false-accept-gos1000040.js";

test("GOS1000040 false Accept Green returns to Bid Submitted", async () => {
    await prisma.setting.deleteMany({
        where: { category: "ops", settingKey: "gos1000040_bid_only" },
    });
    await prisma.shipmentLead.deleteMany({ where: { greenOsShipmentId: "GOS1000040" } });
    const lead = await prisma.shipmentLead.create({
        data: {
            source: "test",
            shipmentTitle: "2 heavy equipment items for transport",
            greenOsShipmentId: "GOS1000040",
            status: "LOAD_CREATED",
            loadNumber: "GL100003",
        },
    });
    await prisma.domainEvent.create({
        data: {
            shipmentLeadId: lead.shipmentLeadId,
            eventType: "CUSTOMER_ACCEPTED",
            title: "Accept Green",
        },
    });
    await prisma.domainEvent.create({
        data: {
            shipmentLeadId: lead.shipmentLeadId,
            eventType: "BID_SUBMITTED",
            title: "Bid Submitted",
        },
    });
    try {
        await revertFalseAcceptGos1000040();
        const updated = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: lead.shipmentLeadId },
        });
        assert.equal(updated?.status, "BID_SUBMITTED");
        assert.equal(updated?.loadNumber, null);
        const events = await prisma.domainEvent.findMany({
            where: { shipmentLeadId: lead.shipmentLeadId },
        });
        assert.equal(events.some((e) => e.eventType === "CUSTOMER_ACCEPTED"), false);
        assert.equal(events.some((e) => e.eventType === "BID_SUBMITTED"), true);
    } finally {
        await prisma.shipmentLead.deleteMany({ where: { greenOsShipmentId: "GOS1000040" } });
        await prisma.setting.deleteMany({
            where: { category: "ops", settingKey: "gos1000040_bid_only" },
        });
    }
});
