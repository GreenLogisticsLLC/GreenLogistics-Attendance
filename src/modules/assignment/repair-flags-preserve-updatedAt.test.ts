import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../../config/database.js";
import { assignmentEngine } from "./assignment.engine.js";

test("repairPassedShipmentFlags does not bump shipment updatedAt", async () => {
    const stamp = Date.now();
    const frozen = new Date("2026-11-19T15:09:00.000Z");
    const lead = await prisma.shipmentLead.create({
        data: {
            source: "TEST",
            shipmentTitle: `repair-flags-${stamp}`,
            status: "WORKING",
            isReassignment: false,
            wasEverReassigned: true,
            updatedAt: frozen,
            createdAt: frozen,
            assignedAt: frozen,
        },
    });

    try {
        await assignmentEngine.repairPassedShipmentFlags();

        const after = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: lead.shipmentLeadId },
        });
        assert.ok(after);
        assert.equal(after!.isReassignment, true);
        assert.equal(after!.wasEverReassigned, true);
        assert.equal(new Date(after!.updatedAt).toISOString(), frozen.toISOString());
    } finally {
        await prisma.shipmentLead.delete({ where: { shipmentLeadId: lead.shipmentLeadId } });
    }
});
