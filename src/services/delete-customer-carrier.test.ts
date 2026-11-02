import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../config/database.js";
import { customerService } from "../modules/customers/services/customer.service.js";
import { carrierService } from "../modules/carriers/services/carrier.service.js";

test("main account can delete a customer and a carrier", async () => {
    const role = await prisma.role.upsert({
        where: { roleName: "Owner" },
        update: {},
        create: { roleName: "Owner", description: "Owner" },
    });
    const owner = await prisma.user.create({
        data: {
            username: `owner-del-${Date.now()}`,
            passwordHash: "x",
            firstName: "Main",
            lastName: "Account",
            email: `owner-del-${Date.now()}@example.com`,
            roleId: role.roleId,
        },
    });
    const actor = { userId: owner.userId, role: "Owner" };
    const customer = await prisma.directCustomer.create({
        data: { companyName: "Delete Me Co", createdByUserId: owner.userId },
    });
    const carrier = await prisma.carrier.create({
        data: { legalName: "Delete Me Carrier", email: `del-carrier-${Date.now()}@example.com` },
    });
    try {
        await assert.rejects(
            () => customerService.remove(customer.customerId, { userId: owner.userId, role: "Broker" }),
            /main account/
        );
        await customerService.remove(customer.customerId, actor);
        assert.equal(
            await prisma.directCustomer.findUnique({ where: { customerId: customer.customerId } }),
            null
        );
        await carrierService.deleteCarrier(carrier.carrierId, actor);
        assert.equal(
            await prisma.carrier.findUnique({ where: { carrierId: carrier.carrierId } }),
            null
        );
    } finally {
        await prisma.directCustomer.deleteMany({ where: { customerId: customer.customerId } });
        await prisma.carrier.deleteMany({ where: { carrierId: carrier.carrierId } });
        await prisma.user.delete({ where: { userId: owner.userId } });
    }
});
