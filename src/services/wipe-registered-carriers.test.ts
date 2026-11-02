import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../config/database.js";
import { wipeRegisteredCarriers } from "./wipe-registered-carriers.js";

test("wipe removes every registered carrier", async () => {
    await prisma.setting.deleteMany({
        where: { category: "ops", settingKey: "carriers_wiped" },
    });
    const carrier = await prisma.carrier.create({
        data: {
            legalName: "Wipe Test Carrier LLC",
            email: `wipe-test-${Date.now()}@example.com`,
            onboardingStatus: "INVITED",
        },
    });
    try {
        await wipeRegisteredCarriers();
        const left = await prisma.carrier.count();
        assert.equal(left, 0);
        const gone = await prisma.carrier.findUnique({ where: { carrierId: carrier.carrierId } });
        assert.equal(gone, null);
    } finally {
        await prisma.carrier.deleteMany({ where: { carrierId: carrier.carrierId } });
        await prisma.setting.deleteMany({
            where: { category: "ops", settingKey: "carriers_wiped" },
        });
    }
});
