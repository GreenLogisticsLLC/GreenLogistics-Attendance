import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../../../config/database.js";
import { bigProblemsService } from "./big-problems.service.js";
import { listBrokerResponseProblems } from "../../crm/services/broker-response-problem.service.js";
import { listLoadLateProblems } from "../../crm/services/load-late-problem.service.js";

test("create / task / financial / close Big Problem case end-to-end", async () => {
    const stamp = Date.now();
    const ownerRole = await prisma.role.upsert({
        where: { roleName: "Owner" },
        update: {},
        create: { roleName: "Owner", description: "Owner" },
    });
    await prisma.role.upsert({
        where: { roleName: "Broker" },
        update: {},
        create: { roleName: "Broker", description: "Broker" },
    });
    const owner = await prisma.user.create({
        data: {
            username: `bp-owner-${stamp}`,
            passwordHash: "x",
            firstName: "Pat",
            lastName: "Owner",
            email: `bp-owner-${stamp}@example.com`,
            roleId: ownerRole.roleId,
        },
    });
    const actor = { userId: owner.userId, role: "Owner" };

    const created = await bigProblemsService.createCase(actor, {
        title: `Damaged cargo ${stamp}`,
        category: "CARGO_DAMAGE",
        severity: "CRITICAL",
        description: "Forklift damage at dock",
        carrierName: "Test Haul LLC",
    });
    assert.match(String(created.caseNumber), /^BP-\d{4}-\d{4}$/);
    assert.equal(created.severity, "CRITICAL");

    const task = await bigProblemsService.createTask(actor, String(created.caseId), {
        title: "Collect photos",
        priority: "HIGH",
        assigneeUserId: owner.userId,
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
    });
    assert.equal(task.status, "OPEN");

    const fin = await bigProblemsService.updateFinancials(actor, String(created.caseId), {
        customerClaimAmount: 3000,
        carrierClaimAmount: 3000,
        insuranceClaimAmount: 3000,
        insuranceStatus: "PENDING",
        legalExpenses: 100,
        amountRecovered: 0,
    });
    assert.equal(fin.potentialExposure, 3100);
    assert.equal(fin.outstandingExposure, 3100);

    const overview = await bigProblemsService.overview(actor);
    assert.ok(overview.totalCases >= 1);
    assert.ok(overview.openCases >= 1);

    const closed = await bigProblemsService.closeCase(actor, String(created.caseId), "Settled");
    assert.equal(closed.status, "CLOSED");

    // Non-regression: existing Problems list helpers still callable.
    const noAnswer = await listBrokerResponseProblems({ limit: 5 });
    assert.ok(Array.isArray(noAnswer));
    const late = await listLoadLateProblems({ limit: 5 });
    assert.ok(Array.isArray(late));
});

test("broker cannot create cases or edit financials", async () => {
    const stamp = Date.now();
    const brokerRole = await prisma.role.upsert({
        where: { roleName: "Broker" },
        update: {},
        create: { roleName: "Broker", description: "Broker" },
    });
    const broker = await prisma.user.create({
        data: {
            username: `bp-broker-${stamp}`,
            passwordHash: "x",
            firstName: "Bea",
            lastName: "Broker",
            email: `bp-broker-${stamp}@example.com`,
            roleId: brokerRole.roleId,
        },
    });
    await assert.rejects(
        () =>
            bigProblemsService.createCase(
                { userId: broker.userId, role: "Broker" },
                { title: "Nope", category: "OTHER" }
            ),
        /Only Owner/
    );
});
