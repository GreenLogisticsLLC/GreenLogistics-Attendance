import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../config/database.js";
import { restoreGl10065FromVoided } from "./restore-gl10065-from-voided.js";

test("restores GL10065 from VOIDED once for Accounting", async () => {
    const settingKey = { category: "ops" as const, settingKey: "gl10065_unvoid" };
    await prisma.setting.deleteMany({
        where: { category: "ops", settingKey: "gl10065_unvoid" },
    });
    await prisma.shipmentLead.deleteMany({
        where: { OR: [{ loadNumber: "GL10065" }, { loadNumber: "10065" }] },
    });

    const lead = await prisma.shipmentLead.create({
        data: {
            source: "test",
            shipmentTitle: "GL10065 restore test",
            status: "VOIDED",
            loadNumber: "GL10065",
            customerName: "Popozuk",
            carrierName: "Test Carrier",
            carrierRate: 3200,
            customerRate: 3500,
            pickupCity: "Rochester",
            pickupState: "NY",
            deliveryCity: "Rochester",
            deliveryState: "NY",
        },
        select: { shipmentLeadId: true },
    });

    await prisma.domainEvent.create({
        data: {
            shipmentLeadId: lead.shipmentLeadId,
            eventType: "STATUS_CHANGED",
            title: "Load voided",
            message: "void",
            payloadJson: JSON.stringify({ from: "CARRIER_ASSIGNED", to: "VOIDED" }),
        },
    });

    try {
        await restoreGl10065FromVoided();
        const after = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: lead.shipmentLeadId },
            select: { status: true },
        });
        assert.equal(after?.status, "CARRIER_ASSIGNED");

        const mark = await prisma.setting.findUnique({
            where: { category_settingKey: settingKey },
        });
        assert.equal(mark?.settingValue, "2026-11-06-gl10065-unvoid");

        await prisma.shipmentLead.update({
            where: { shipmentLeadId: lead.shipmentLeadId },
            data: { status: "VOIDED" },
        });
        await restoreGl10065FromVoided();
        const again = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: lead.shipmentLeadId },
            select: { status: true },
        });
        assert.equal(again?.status, "VOIDED", "second run must not change status again");
    } finally {
        await prisma.shipmentTimelineEvent.deleteMany({
            where: { shipmentLeadId: lead.shipmentLeadId },
        });
        await prisma.domainEvent.deleteMany({ where: { shipmentLeadId: lead.shipmentLeadId } });
        await prisma.shipmentLead.delete({ where: { shipmentLeadId: lead.shipmentLeadId } });
        await prisma.setting.deleteMany({
            where: { category: "ops", settingKey: "gl10065_unvoid" },
        });
    }
});
