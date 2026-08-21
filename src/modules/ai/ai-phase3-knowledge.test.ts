import test from "node:test";
import assert from "node:assert/strict";
import { _aiOrchestratorTestUtils } from "./services/ai-orchestrator.js";
import { aiTools } from "./services/ai-tools.js";
import { SCORE } from "./knowledge/scoring.js";
import { StructuredKnowledgeSearchProvider } from "./knowledge/structured-provider.js";
import { greenOsKnowledgeSearch } from "./knowledge/search.service.js";
import { extractMcDigits } from "./services/ai-mc-normalize.js";
import { prisma } from "../../config/database.js";

const { detectIntent, NOT_FOUND_LINE } = _aiOrchestratorTestUtils;

test("Phase 3 intents: compliance / email / timeline / multi / general", () => {
    assert.equal(detectIntent("Which carriers have insurance expiring this month?").kind, "compliance");
    assert.equal(detectIntent("Find carriers with missing W9").kind, "compliance");
    assert.equal(detectIntent("What did the customer email us about load 75246?").kind, "email");
    assert.equal(detectIntent("What happened with load 75246 yesterday?").kind, "timeline");
    assert.equal(detectIntent("Tell me everything about MC 1234545").kind, "carrier_summary");
    assert.equal(detectIntent("What is a rate confirmation?").kind, "general");
    assert.equal(detectIntent("What is the status of ABC Trucking LLC?").kind, "carrier");
});

test("scoring constants are deterministic and ordered", () => {
    assert.ok(SCORE.EXACT_MC_DOT_LOAD > SCORE.EXACT_NAME);
    assert.ok(SCORE.EXACT_NAME > SCORE.KEYWORD);
    assert.ok(SCORE.KEYWORD > SCORE.GENERAL_TEXT);
});

test("searchGreenOS empty query → NOT_FOUND", async () => {
    const r = await aiTools.searchGreenOS({ userId: "u1", role: "Administrator" }, " ");
    assert.equal(r.ok, false);
    assert.equal(r.code, "NOT_FOUND");
    assert.equal(r.message, NOT_FOUND_LINE);
});

test("searchGreenOS no-result does not invent", async () => {
    const r = await aiTools.searchGreenOS(
        { userId: "u1", role: "Administrator" },
        "ZZZ_NO_SUCH_CARRIER_XYZ_99999999"
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, "NOT_FOUND");
    assert.deepEqual(r.sources, []);
});

test("KnowledgeSearchProvider name is structured", () => {
    const p = new StructuredKnowledgeSearchProvider();
    assert.equal(p.name, "StructuredKnowledgeSearchProvider");
    assert.equal(greenOsKnowledgeSearch.searchMode, "StructuredKnowledgeSearchProvider");
});

test("MC normalize for search variants", () => {
    assert.equal(extractMcDigits("MC1234545"), "1234545");
    assert.equal(extractMcDigits("MC-1234545"), "1234545");
    assert.equal(extractMcDigits("MC 1234545"), "1234545");
    assert.equal(extractMcDigits("1234545"), "1234545");
});

test("ACL: Broker A cannot see Broker B carrier via searchGreenOS", async () => {
    const suffix = Date.now().toString(36);
    let brokerA: { userId: string } | null = null;
    let brokerB: { userId: string } | null = null;
    let carrierB: { carrierId: string } | null = null;
    try {
        const role = await prisma.role.findFirst({ where: { roleName: "Broker" } });
        if (!role) {
            // Skip when fixture roles missing
            return;
        }
        brokerA = await prisma.user.create({
            data: {
                username: `phase3a_${suffix}`,
                email: `phase3-a-${suffix}@example.invalid`,
                passwordHash: "x",
                firstName: "A",
                lastName: "Broker",
                roleId: role.roleId,
                isActive: true,
            },
            select: { userId: true },
        });
        brokerB = await prisma.user.create({
            data: {
                username: `phase3b_${suffix}`,
                email: `phase3-b-${suffix}@example.invalid`,
                passwordHash: "x",
                firstName: "B",
                lastName: "Broker",
                roleId: role.roleId,
                isActive: true,
            },
            select: { userId: true },
        });
        carrierB = await prisma.carrier.create({
            data: {
                legalName: `Phase3 ACL Carrier ${suffix} LLC`,
                email: `phase3-c-${suffix}@example.invalid`,
                mcNumber: `9${String(Date.now()).slice(-6)}`,
                assignedBrokerId: brokerB.userId,
                status: "ACTIVE",
                onboardingStatus: "APPROVED",
            },
            select: { carrierId: true, mcNumber: true },
        });

        const denied = await aiTools.searchGreenOS(
            { userId: brokerA.userId, role: "Broker" },
            String((carrierB as { mcNumber?: string }).mcNumber || ""),
            { intentHint: "carrier" }
        );
        assert.equal(denied.ok, false);

        const allowed = await aiTools.searchGreenOS(
            { userId: brokerB.userId, role: "Broker" },
            String((carrierB as { mcNumber?: string }).mcNumber || ""),
            { intentHint: "carrier" }
        );
        assert.equal(allowed.ok, true);
        assert.ok(Array.isArray((allowed.data as { results: unknown[] }).results));
        assert.ok(((allowed.data as { results: unknown[] }).results || []).length >= 1);
    } finally {
        if (carrierB) await prisma.carrier.delete({ where: { carrierId: carrierB.carrierId } }).catch(() => null);
        if (brokerA) await prisma.user.delete({ where: { userId: brokerA.userId } }).catch(() => null);
        if (brokerB) await prisma.user.delete({ where: { userId: brokerB.userId } }).catch(() => null);
    }
});

test("exact MC search returns MATCH score path", async () => {
    const suffix = Date.now().toString(36);
    const mc = `8${String(Date.now()).slice(-6)}`;
    let carrier: { carrierId: string } | null = null;
    try {
        carrier = await prisma.carrier.create({
            data: {
                legalName: `Phase3 MC Search ${suffix} LLC`,
                email: `phase3-mc-${suffix}@example.invalid`,
                mcNumber: mc,
                status: "ACTIVE",
                onboardingStatus: "APPROVED",
            },
            select: { carrierId: true },
        });
        const r = await greenOsKnowledgeSearch.search({
            actor: { userId: "admin", role: "Administrator" },
            query: `MC${mc}`,
            filters: { intentHint: "carrier", entityType: "CARRIER" },
        });
        assert.equal(r.searchMode, "STRUCTURED");
        assert.ok(r.results.length >= 1);
        assert.equal(r.results[0].type, "CARRIER");
        assert.ok(r.results[0].score >= SCORE.EXACT_MC_DOT_LOAD - 0.01);
        assert.ok(r.sources.some((s) => s.id === carrier!.carrierId));
    } finally {
        if (carrier) await prisma.carrier.delete({ where: { carrierId: carrier.carrierId } }).catch(() => null);
    }
});

test("shipment ACL denial via search does not leak", async () => {
    const suffix = Date.now().toString(36);
    const role = await prisma.role.findFirst({ where: { roleName: "Broker" } });
    if (!role) return;
    let brokerA: { userId: string } | null = null;
    let brokerB: { userId: string } | null = null;
    let lead: { shipmentLeadId: string } | null = null;
    try {
        brokerA = await prisma.user.create({
            data: {
                username: `phase3sa_${suffix}`,
                email: `phase3-sa-${suffix}@example.invalid`,
                passwordHash: "x",
                firstName: "SA",
                lastName: "Broker",
                roleId: role.roleId,
                isActive: true,
            },
            select: { userId: true },
        });
        brokerB = await prisma.user.create({
            data: {
                username: `phase3sb_${suffix}`,
                email: `phase3-sb-${suffix}@example.invalid`,
                passwordHash: "x",
                firstName: "SB",
                lastName: "Broker",
                roleId: role.roleId,
                isActive: true,
            },
            select: { userId: true },
        });
        const loadNumber = `9${String(Date.now()).slice(-5)}`;
        lead = await prisma.shipmentLead.create({
            data: {
                source: "TEST",
                shipmentTitle: `Phase3 ACL Load ${suffix}`,
                loadNumber,
                assignedBrokerId: brokerB.userId,
                status: "BOOKED",
            },
            select: { shipmentLeadId: true },
        });
        const denied = await aiTools.searchGreenOS(
            { userId: brokerA.userId, role: "Broker" },
            loadNumber,
            { intentHint: "shipment", entityType: "SHIPMENT" }
        );
        assert.equal(denied.ok, false);
    } finally {
        if (lead) await prisma.shipmentLead.delete({ where: { shipmentLeadId: lead.shipmentLeadId } }).catch(() => null);
        if (brokerA) await prisma.user.delete({ where: { userId: brokerA.userId } }).catch(() => null);
        if (brokerB) await prisma.user.delete({ where: { userId: brokerB.userId } }).catch(() => null);
    }
});
