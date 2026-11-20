import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { allocateLoadNumber, formatLoadNumber, parseLoadNumberSeq } from "./load-number.js";
import { shipmentService } from "./services/shipment.service.js";

const prisma = new PrismaClient();

async function resetCounter(seq: number) {
    await prisma.setting.upsert({
        where: {
            category_settingKey: { category: "shipment", settingKey: "next_load_number" },
        },
        create: {
            category: "shipment",
            settingKey: "next_load_number",
            settingValue: formatLoadNumber(seq),
            description: "test",
        },
        update: { settingValue: formatLoadNumber(seq) },
    });
}

test("allocateLoadNumber yields consecutive GL numbers", async () => {
    await resetCounter(10208);
    const a = await allocateLoadNumber();
    const b = await allocateLoadNumber();
    const c = await allocateLoadNumber();
    assert.equal(a, "GL10208");
    assert.equal(b, "GL10209");
    assert.equal(c, "GL10210");
    assert.equal(parseLoadNumberSeq(b)! - parseLoadNumberSeq(a)!, 1);
    assert.equal(parseLoadNumberSeq(c)! - parseLoadNumberSeq(b)!, 1);
});

test("createLoadAfterAccepted on ACCEPTED alias allocates only one GL number", async () => {
    await resetCounter(10220);
    const lead = await prisma.shipmentLead.create({
        data: {
            source: "USHIP",
            shipmentTitle: "Sequential load number test",
            status: "ACCEPTED",
            acceptedAt: new Date(),
        },
    });
    const before = await prisma.setting.findUnique({
        where: {
            category_settingKey: { category: "shipment", settingKey: "next_load_number" },
        },
    });
    const beforeSeq = parseLoadNumberSeq(before?.settingValue)!;

    const updated = await shipmentService.createLoadAfterAccepted({
        shipmentLeadId: lead.shipmentLeadId,
    });
    assert.equal(updated.loadNumber, "GL10220");

    const after = await prisma.setting.findUnique({
        where: {
            category_settingKey: { category: "shipment", settingKey: "next_load_number" },
        },
    });
    const afterSeq = parseLoadNumberSeq(after?.settingValue)!;
    assert.equal(afterSeq, beforeSeq + 1, "must advance by 1, not 2");

    await prisma.shipmentLead.delete({ where: { shipmentLeadId: lead.shipmentLeadId } });
});

test("createLoadAfterAccepted from BID_SUBMITTED promotes Accept Green and Create Load", async () => {
    await resetCounter(10230);
    const lead = await prisma.shipmentLead.create({
        data: {
            source: "USHIP",
            shipmentTitle: "1 Pallet Soft Goods Congrats",
            status: "BID_SUBMITTED",
        },
    });
    const updated = await shipmentService.createLoadAfterAccepted({
        shipmentLeadId: lead.shipmentLeadId,
    });
    assert.equal(updated.loadNumber, "GL10230");
    assert.equal(updated.status, "LOAD_CREATED");
    await prisma.shipmentLead.delete({ where: { shipmentLeadId: lead.shipmentLeadId } });
});

test("createLoadAfterAccepted retries when already ACCEPT_GREEN without GL#", async () => {
    await resetCounter(10231);
    const lead = await prisma.shipmentLead.create({
        data: {
            source: "USHIP",
            shipmentTitle: "1 Pallet already Accepted",
            status: "ACCEPT_GREEN",
            acceptedAt: new Date(),
        },
    });
    const updated = await shipmentService.createLoadAfterAccepted({
        shipmentLeadId: lead.shipmentLeadId,
    });
    assert.equal(updated.loadNumber, "GL10231");
    assert.equal(updated.status, "LOAD_CREATED");
    await prisma.shipmentLead.delete({ where: { shipmentLeadId: lead.shipmentLeadId } });
});

test.after(async () => {
    await prisma.$disconnect();
});
