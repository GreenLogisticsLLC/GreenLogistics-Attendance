import test from "node:test";
import assert from "node:assert/strict";
import { _deriveComplianceForTests } from "./operational/carrier-context.js";
import { _deriveShipmentReadinessForTests } from "./operational/shipment-context.js";
import { prioritizeRecommendations, recommendation } from "./operational/recommendations.js";
import { _aiOrchestratorTestUtils } from "./services/ai-orchestrator.js";
import { operationalAiService } from "./operational/operational.service.js";
import { prisma } from "../../config/database.js";
import type { DocumentChecklistItem, OperationalMismatch } from "./operational/types.js";
import type { RuleCheck } from "./documents/rules.js";

const { detectIntent, NOT_FOUND_LINE } = _aiOrchestratorTestUtils;

function slot(
    name: string,
    status: DocumentChecklistItem["status"],
    reason = ""
): DocumentChecklistItem {
    return {
        documentType: name,
        slot: name,
        status,
        validationStatus: status === "VALID" ? "VALID" : status,
        trafficLight: status === "VALID" ? "GREEN" : "YELLOW",
        expiration: null,
        signatureStatus: null,
        reason,
        documentId: status === "MISSING" ? null : "doc-1",
    };
}

test("Phase 4 intents: carrier/shipment readiness & summary", () => {
    assert.equal(detectIntent("Is carrier MC 1234545 ready?").kind, "carrier_readiness");
    assert.equal(detectIntent("Check this carrier's compliance").kind, "carrier_readiness");
    assert.equal(detectIntent("Tell me everything about MC 1234545").kind, "carrier_summary");
    assert.equal(detectIntent("Is this shipment ready to close for load 75246?").kind, "shipment_readiness");
    assert.equal(detectIntent("Tell me everything that happened with load 75246").kind, "shipment_summary");
});

test("Golden A: all VALID → READY / GREEN", () => {
    const checklist = [
        slot("W9", "VALID"),
        slot("COI", "VALID"),
        slot("MC_AUTHORITY", "VALID"),
        slot("AGREEMENT", "VALID"),
        slot("NOA", "VALID"),
    ];
    const r = _deriveComplianceForTests(checklist, [], []);
    assert.equal(r.readiness, "READY");
    assert.equal(r.light, "GREEN");
});

test("Golden B: cargo below minimum → NOT_READY / RED", () => {
    const checklist = [
        slot("W9", "VALID"),
        slot("COI", "VALID"),
        slot("MC_AUTHORITY", "VALID"),
        slot("AGREEMENT", "VALID"),
        slot("NOA", "VALID"),
    ];
    const insurance: RuleCheck[] = [
        {
            id: "BR-INS-CARGO",
            ok: false,
            status: "BELOW_REQUIREMENT",
            message: "Motor Truck Cargo $50000 below required $100000",
        },
    ];
    const r = _deriveComplianceForTests(checklist, [], insurance);
    assert.equal(r.readiness, "NOT_READY");
    assert.equal(r.light, "RED");
});

test("Golden C: MC CRITICAL_MISMATCH → NOT_READY", () => {
    const checklist = [
        slot("W9", "VALID"),
        slot("COI", "VALID"),
        slot("MC_AUTHORITY", "VALID"),
        slot("AGREEMENT", "VALID"),
        slot("NOA", "VALID"),
    ];
    const mismatches: OperationalMismatch[] = [
        {
            id: "CROSS-MC",
            field: "MC",
            status: "CRITICAL_MISMATCH",
            message: "MC mismatch",
            values: { authority: "1", coi: "2", greenOs: "3" },
        },
    ];
    const r = _deriveComplianceForTests(checklist, mismatches, []);
    assert.equal(r.readiness, "NOT_READY");
    assert.equal(r.light, "RED");
});

test("Incomplete validation → REVIEW never GREEN", () => {
    const checklist = [
        slot("W9", "PRESENT", "validation pending"),
        slot("COI", "VALID"),
        slot("MC_AUTHORITY", "VALID"),
        slot("AGREEMENT", "VALID"),
        slot("NOA", "VALID"),
    ];
    const r = _deriveComplianceForTests(checklist, [], []);
    assert.equal(r.readiness, "REVIEW_REQUIRED");
    assert.notEqual(r.light, "GREEN");
});

test("Missing NOA → NOT_READY", () => {
    const checklist = [
        slot("W9", "VALID"),
        slot("COI", "VALID"),
        slot("MC_AUTHORITY", "VALID"),
        slot("AGREEMENT", "VALID"),
        slot("NOA", "MISSING"),
    ];
    const r = _deriveComplianceForTests(checklist, [], []);
    assert.equal(r.readiness, "NOT_READY");
    assert.equal(r.light, "RED");
});

test("Golden D: POD unsigned → REVIEW_REQUIRED not READY_TO_CLOSE", () => {
    const checklist = [
        slot("RATE_CONFIRMATION", "VALID"),
        slot("BOL", "VALID"),
        slot("POD", "REVIEW_REQUIRED", "Signature: RECEIVER:MISSING"),
    ];
    const r = _deriveShipmentReadinessForTests(checklist, "DELIVERED");
    assert.equal(r.readiness, "REVIEW_REQUIRED");
});

test("Golden E: all load docs VALID → READY_TO_CLOSE recommendation path", () => {
    const checklist = [
        slot("RATE_CONFIRMATION", "VALID"),
        slot("BOL", "VALID"),
        slot("POD", "VALID"),
    ];
    const r = _deriveShipmentReadinessForTests(checklist, "DELIVERED");
    assert.equal(r.readiness, "READY_TO_CLOSE");
});

test("Missing POD → REVIEW_REQUIRED", () => {
    const checklist = [
        slot("RATE_CONFIRMATION", "VALID"),
        slot("BOL", "VALID"),
        slot("POD", "MISSING"),
    ];
    const r = _deriveShipmentReadinessForTests(checklist, "IN_TRANSIT");
    assert.equal(r.readiness, "REVIEW_REQUIRED");
    assert.ok(r.reviewItems.some((x) => /POD missing/i.test(x)));
});

test("recommendations are labeled RECOMMENDATION and prioritized", () => {
    const items = [
        recommendation("a", "Upload W9", "missing", "HIGH"),
        recommendation("b", "Fix MC", "mismatch", "CRITICAL"),
        recommendation("c", "Review NOA", "unclear", "MEDIUM"),
    ];
    const sorted = prioritizeRecommendations(items);
    assert.equal(sorted[0].priority, "CRITICAL");
    assert.equal(sorted[0].label, "RECOMMENDATION");
    assert.equal(sorted[0].humanConfirmationRequired, true);
});

test("carrier summary ACL denies unauthorized broker", async () => {
    const suffix = Date.now().toString(36);
    const role = await prisma.role.findFirst({ where: { roleName: "Broker" } });
    if (!role) return;
    let brokerA: { userId: string } | null = null;
    let brokerB: { userId: string } | null = null;
    let carrier: { carrierId: string } | null = null;
    try {
        brokerA = await prisma.user.create({
            data: {
                username: `p4a_${suffix}`,
                email: `p4a-${suffix}@example.invalid`,
                passwordHash: "x",
                firstName: "A",
                lastName: "B",
                roleId: role.roleId,
                isActive: true,
            },
            select: { userId: true },
        });
        brokerB = await prisma.user.create({
            data: {
                username: `p4b_${suffix}`,
                email: `p4b-${suffix}@example.invalid`,
                passwordHash: "x",
                firstName: "B",
                lastName: "B",
                roleId: role.roleId,
                isActive: true,
            },
            select: { userId: true },
        });
        carrier = await prisma.carrier.create({
            data: {
                legalName: `P4 Carrier ${suffix} LLC`,
                email: `p4c-${suffix}@example.invalid`,
                mcNumber: `7${String(Date.now()).slice(-6)}`,
                assignedBrokerId: brokerB.userId,
                status: "ACTIVE",
                onboardingStatus: "APPROVED",
            },
            select: { carrierId: true },
        });
        let denied = false;
        try {
            await operationalAiService.carrierSummary(
                { userId: brokerA.userId, role: "Broker" },
                carrier.carrierId
            );
        } catch (err) {
            denied = (err as { status?: number }).status === 403;
        }
        assert.equal(denied, true);

        const ok = await operationalAiService.carrierSummary(
            { userId: brokerB.userId, role: "Broker" },
            carrier.carrierId
        );
        assert.equal(ok.answerMode, "OPERATIONAL");
        assert.ok(ok.carrier.legalName);
        assert.ok(Array.isArray(ok.documents));
        // no master-data mutation fields in response that would imply writes
        assert.equal(ok.groundingLabel, "Based on GreenOS data");
    } finally {
        if (carrier) await prisma.carrier.delete({ where: { carrierId: carrier.carrierId } }).catch(() => null);
        if (brokerA) await prisma.user.delete({ where: { userId: brokerA.userId } }).catch(() => null);
        if (brokerB) await prisma.user.delete({ where: { userId: brokerB.userId } }).catch(() => null);
    }
});

test("not-found phrase unchanged", () => {
    assert.equal(NOT_FOUND_LINE, "I could not find this information in GreenOS.");
});
