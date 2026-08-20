import test from "node:test";
import assert from "node:assert/strict";
import { estimateCostUsd, getModelPricing } from "./services/ai-pricing.js";
import {
    assertAiChatRateLimit,
    getAiChatRateLimitPerMinute,
    _resetAiRateLimitForTests,
} from "./services/ai-rate-limit.js";
import { _aiOrchestratorTestUtils } from "./services/ai-orchestrator.js";
import { aiTools } from "./services/ai-tools.js";

const { detectIntent, NOT_FOUND_LINE } = _aiOrchestratorTestUtils;

test("pricing is centralized and positive for gpt-4o-mini", () => {
    const p = getModelPricing("gpt-4o-mini");
    assert.ok(p.inputPerMillionUsd > 0);
    assert.ok(p.outputPerMillionUsd > 0);
    const cost = estimateCostUsd({
        model: "gpt-4o-mini",
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
    });
    assert.equal(cost, p.inputPerMillionUsd + p.outputPerMillionUsd);
});

test("rate limit rejects after configured threshold", () => {
    _resetAiRateLimitForTests();
    const prev = process.env.AI_CHAT_RATE_LIMIT_PER_MINUTE;
    process.env.AI_CHAT_RATE_LIMIT_PER_MINUTE = "3";
    const user = "rate-limit-test-user";
    try {
        assert.equal(getAiChatRateLimitPerMinute(), 3);
        assertAiChatRateLimit(user);
        assertAiChatRateLimit(user);
        assertAiChatRateLimit(user);
        let threw = false;
        try {
            assertAiChatRateLimit(user);
        } catch (err) {
            threw = true;
            assert.equal((err as { status?: number }).status, 429);
            assert.match((err as Error).message, /rate limit/i);
        }
        assert.equal(threw, true);
    } finally {
        if (prev === undefined) delete process.env.AI_CHAT_RATE_LIMIT_PER_MINUTE;
        else process.env.AI_CHAT_RATE_LIMIT_PER_MINUTE = prev;
        _resetAiRateLimitForTests();
    }
});

test("intent: carrier by name / docs / shipment load number / general", () => {
    assert.equal(detectIntent("What is the status of ABC Trucking LLC?").kind, "carrier");
    assert.equal(detectIntent('When does "ABC Trucking" COI expire?').kind, "carrier_docs");
    assert.equal(detectIntent("Show shipment GL100042 details").kind, "shipment");
    assert.equal(detectIntent("How does Round Robin assignment work?").kind, "general");
});

test("not-found phrase is fixed (no hallucination copy)", () => {
    assert.equal(NOT_FOUND_LINE, "I could not find this information in GreenOS.");
});

test("getCarrierById returns NOT_FOUND for empty id without LLM", async () => {
    const r = await aiTools.getCarrierById({ userId: "u1", role: "Broker" }, "  ");
    assert.equal(r.ok, false);
    assert.equal(r.code, "NOT_FOUND");
    assert.equal(r.message, NOT_FOUND_LINE);
    assert.deepEqual(r.sources, []);
});

test("getShipmentById returns NOT_FOUND for empty id", async () => {
    const r = await aiTools.getShipmentById({ userId: "u1", role: "Broker" }, "");
    assert.equal(r.ok, false);
    assert.equal(r.code, "NOT_FOUND");
    assert.equal(r.message, NOT_FOUND_LINE);
});

test("listCarrierDocuments returns NOT_FOUND for empty id", async () => {
    const r = await aiTools.listCarrierDocuments({ userId: "u1", role: "Broker" }, "");
    assert.equal(r.ok, false);
    assert.equal(r.code, "NOT_FOUND");
});

test("missing carrier uuid → NOT_FOUND (no invent)", async () => {
    const r = await aiTools.getCarrierById(
        { userId: "u1", role: "Administrator" },
        "00000000-0000-4000-8000-000000000099"
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, "NOT_FOUND");
    assert.equal(r.message, NOT_FOUND_LINE);
});

test("missing shipment uuid → NOT_FOUND", async () => {
    const r = await aiTools.getShipmentById(
        { userId: "u1", role: "Administrator" },
        "00000000-0000-4000-8000-000000000098"
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, "NOT_FOUND");
});

test("ACL: carrier tool returns FORBIDDEN when assertCarrierAccess denies", async () => {
    const { carrierService } = await import("../carriers/services/carrier.service.js");
    const orig = carrierService.assertCarrierAccess.bind(carrierService);
    carrierService.assertCarrierAccess = async () => {
        throw Object.assign(new Error("Access denied"), { status: 403 });
    };
    try {
        const r = await aiTools.getCarrierById(
            { userId: "broker-a", role: "Broker" },
            "11111111-1111-4111-8111-111111111111"
        );
        assert.equal(r.ok, false);
        assert.equal(r.code, "FORBIDDEN");
        assert.equal(r.message, "Access denied.");
        assert.deepEqual(r.sources, []);
    } finally {
        carrierService.assertCarrierAccess = orig;
    }
});

test("ACL: Broker cannot read another broker's shipment (when present)", async () => {
    const { prisma } = await import("../../config/database.js");
    const lead = await prisma.shipmentLead.findFirst({
        where: { assignedBrokerId: { not: null } },
        select: { shipmentLeadId: true, assignedBrokerId: true },
    });
    if (!lead?.assignedBrokerId) {
        // Local empty DB — skip without failing CI shape.
        return;
    }
    const outsider = "ai-phase1-outsider-broker";
    if (outsider === lead.assignedBrokerId) return;
    const r = await aiTools.getShipmentById(
        { userId: outsider, role: "Broker" },
        lead.shipmentLeadId
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, "FORBIDDEN");
    assert.equal(r.message, "Access denied.");
});

test("MC normalize extracts digits from common variants", async () => {
    const { extractMcDigits, mcSearchVariants } = await import("./services/ai-mc-normalize.js");
    for (const v of ["1234545", "MC 1234545", "MC-1234545", "mc1234545", "MC#1234545"]) {
        assert.equal(extractMcDigits(v), "1234545", v);
    }
    const variants = mcSearchVariants("MC 1234545");
    assert.ok(variants.includes("1234545"));
    assert.ok(variants.includes("MC1234545"));
});

test("intent: MC in sentence uses digits-only carrier query", () => {
    const intent = detectIntent(
        "Tell me the name, MC 1234545 number and status of this carrier"
    );
    assert.equal(intent.kind, "carrier");
    assert.equal(intent.query, "1234545");
});

test("findCarriers matches MC variants against digits-only stored mcNumber", async () => {
    const { prisma } = await import("../../config/database.js");
    const carrierId = "ai-mc-test-0000-4000-8000-000000000001";
    const email = `ai-mc-test-${Date.now()}@example.invalid`;
    await prisma.carrier.deleteMany({ where: { carrierId } }).catch(() => null);
    await prisma.carrier.create({
        data: {
            carrierId,
            legalName: "AI MC Lookup Test Carrier LLC",
            email,
            mcNumber: "1234545",
            status: "ACTIVE",
            onboardingStatus: "APPROVED",
            assignedBrokerId: null,
        },
    });
    try {
        for (const q of ["1234545", "MC 1234545", "MC-1234545", "mc1234545", "MC1234545"]) {
            const r = await aiTools.findCarriers(
                { userId: "admin-test", role: "Administrator" },
                q
            );
            assert.equal(r.ok, true, `expected hit for ${q}`);
            assert.ok(Array.isArray(r.data) && r.data.length >= 1, q);
            const hit = (r.data as Array<{ carrierId: string; mcNumber: string | null }>).find(
                (c) => c.carrierId === carrierId
            );
            assert.ok(hit, `carrier not in results for ${q}`);
            assert.equal(hit.mcNumber, "1234545");
            assert.ok(r.sources.some((s) => s.id === carrierId));
        }

        // Broker list scope requires assignedBrokerId = broker — unassigned must not leak.
        const denied = await aiTools.findCarriers(
            { userId: "other-broker", role: "Broker" },
            "1234545"
        );
        assert.equal(denied.ok, false);
        assert.equal(denied.code, "NOT_FOUND");
    } finally {
        await prisma.carrier.deleteMany({ where: { carrierId } });
    }
});
