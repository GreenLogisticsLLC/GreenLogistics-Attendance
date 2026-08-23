import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../../config/database.js";
import { assertShipmentAccessOrThrow } from "../../auth/access.js";
import { _aiOrchestratorTestUtils } from "./services/ai-orchestrator.js";
import { documentDedupeKey } from "./command-center/dedupe.js";
import { aiActionService } from "./actions/action.service.js";
import { proposalsFromOperationalRecommendations } from "./actions/proposals.js";
import { _lifecycleTestUtils } from "./lifecycle/service.js";
import type { DocumentChecklistItem } from "./operational/types.js";
import type { LifecycleEvidence } from "./lifecycle/types.js";

function doc(
    slot: string,
    status: DocumentChecklistItem["status"],
    options: Partial<DocumentChecklistItem> = {}
): DocumentChecklistItem {
    return {
        documentType: slot,
        slot,
        status,
        validationStatus: null,
        trafficLight: null,
        expiration: null,
        signatureStatus: null,
        reason: `${slot} fixture`,
        documentId: `${slot.toLowerCase()}-fixture`,
        ...options,
    };
}

test("golden A — early statuses map to deterministic conceptual stages", () => {
    assert.equal(_lifecycleTestUtils.deriveCurrentStage({ status: "NEW" }), "NEW");
    assert.equal(_lifecycleTestUtils.deriveCurrentStage({ status: "WORKING" }), "ASSIGNED");
    assert.equal(
        _lifecycleTestUtils.deriveCurrentStage({ status: "ACCEPTED" }),
        "CUSTOMER_CONFIRMED"
    );
});

test("golden B — carrier assignment and rate evidence advance without changing DB status", () => {
    assert.equal(
        _lifecycleTestUtils.deriveCurrentStage({ status: "CARRIER_ASSIGNED" }),
        "CARRIER_SELECTED"
    );
    assert.equal(
        _lifecycleTestUtils.deriveCurrentStage({
            status: "CARRIER_ASSIGNED",
            ratePresent: true,
        }),
        "RATE_CONFIRMED"
    );
});

test("golden C — carrier RED compliance blocks lifecycle", () => {
    const evidence: LifecycleEvidence = {
        status: "RATE_CON_GENERATED",
        carrierCompliance: { readiness: "NOT_READY", light: "RED" },
    };
    const stage = _lifecycleTestUtils.deriveCurrentStage(evidence);
    const issues = _lifecycleTestUtils.deriveLifecycleIssues(evidence, stage);
    assert.equal(stage, "CARRIER_COMPLIANCE");
    assert.equal(
        _lifecycleTestUtils.deriveLifecycleHealth({
            ...issues,
            incompleteSubsystems: [],
        }),
        "BLOCKED"
    );
});

test("golden D — unsigned POD is POD_REVIEW and closeout requires review", () => {
    const evidence: LifecycleEvidence = {
        status: "POD_UPLOADED",
        documents: [
            doc("POD", "REVIEW_REQUIRED", {
                validationStatus: "REVIEW_REQUIRED",
                signatureStatus: "DRIVER:UNSIGNED",
            }),
        ],
        closeoutReadiness: "REVIEW_REQUIRED",
    };
    const stage = _lifecycleTestUtils.deriveCurrentStage(evidence);
    const issues = _lifecycleTestUtils.deriveLifecycleIssues(evidence, stage);
    assert.equal(stage, "POD_REVIEW");
    assert.ok(issues.blockers.some((issue) => issue.code === "POD_SIGNATURE_REVIEW"));
    assert.equal(evidence.closeoutReadiness, "REVIEW_REQUIRED");
});

test("golden E — waiting customer and market P75 are warnings, not blockers", () => {
    const evidence: LifecycleEvidence = {
        status: "WORKING",
        communication: {
            waitingFor: "WAITING_FOR_CUSTOMER",
            followUp: { needed: "YES", reason: "Awaiting reply" },
        },
        marketAssessment: "ABOVE_HISTORICAL_P75",
    };
    const issues = _lifecycleTestUtils.deriveLifecycleIssues(evidence, "ASSIGNED");
    assert.equal(issues.blockers.length, 0);
    assert.ok(issues.warnings.some((issue) => issue.code === "WAITING_FOR_CUSTOMER"));
    assert.ok(issues.warnings.some((issue) => issue.code === "MARKET_ABOVE_P75"));
    assert.equal(
        _lifecycleTestUtils.deriveNextBestAction({
            stage: "ASSIGNED",
            evidence,
            ...issues,
        }),
        "FOLLOW_UP_CUSTOMER"
    );
});

test("golden F — READY_TO_CLOSE only recommends manual close", () => {
    const evidence: LifecycleEvidence = {
        status: "COMPLETED",
        closeoutReadiness: "READY_TO_CLOSE",
    };
    const stage = _lifecycleTestUtils.deriveCurrentStage(evidence);
    assert.equal(stage, "CLOSEOUT");
    assert.equal(
        _lifecycleTestUtils.deriveNextBestAction({
            stage,
            evidence,
            blockers: [],
            warnings: [],
        }),
        "CLOSE_SHIPMENT_MANUALLY"
    );
    assert.equal(evidence.status, "COMPLETED");
});

test("golden G — failed subsystem produces INCOMPLETE health", () => {
    assert.equal(
        _lifecycleTestUtils.deriveLifecycleHealth({
            blockers: [],
            warnings: [],
            incompleteSubsystems: ["tracking"],
        }),
        "INCOMPLETE"
    );
});

test("chat detects Phase 9 shipment lifecycle intents", () => {
    assert.equal(
        _aiOrchestratorTestUtils.detectIntent("Show lifecycle for load GL100001").kind,
        "shipment_lifecycle"
    );
    assert.equal(
        _aiOrchestratorTestUtils.detectIntent("What blocks shipment GL100001?").kind,
        "shipment_blockers"
    );
    assert.equal(
        _aiOrchestratorTestUtils.detectIntent("Next action for load GL100001").kind,
        "shipment_next_action"
    );
});

test("command-center lifecycle POD dedupe key stays stable", () => {
    assert.equal(documentDedupeKey("shipment", "s1", "POD"), "shipment:s1:pod:POD");
});

test("lifecycle ACL isolates brokers and Phase 6 proposal stays confirmation-gated", async () => {
    const role = await prisma.role.upsert({
        where: { roleName: "Broker" },
        update: {},
        create: { roleName: "Broker", description: "Broker" },
    });
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const brokerA = await prisma.user.create({
        data: {
            username: `p9a_${suffix}`,
            email: `p9a-${suffix}@example.invalid`,
            passwordHash: "x",
            firstName: "A",
            lastName: "Phase9",
            roleId: role.roleId,
            isActive: true,
        },
    });
    const brokerB = await prisma.user.create({
        data: {
            username: `p9b_${suffix}`,
            email: `p9b-${suffix}@example.invalid`,
            passwordHash: "x",
            firstName: "B",
            lastName: "Phase9",
            roleId: role.roleId,
            isActive: true,
        },
    });
    const shipment = await prisma.shipmentLead.create({
        data: {
            source: "PHASE9_TEST",
            shipmentTitle: `Phase 9 ${suffix}`,
            status: "DELIVERED",
            assignedBrokerId: brokerA.userId,
        },
    });
    try {
        await assert.rejects(
            assertShipmentAccessOrThrow(
                { userId: brokerB.userId, role: "Broker" },
                shipment.shipmentLeadId
            ),
            (error: unknown) => (error as { status?: number }).status === 403
        );
        const draft = proposalsFromOperationalRecommendations({
            shipmentLeadId: shipment.shipmentLeadId,
            recommendations: [
                {
                    id: "req-pod",
                    text: "Request POD",
                    reason: "Signed POD is missing",
                    priority: "HIGH",
                },
            ],
        })[0];
        const action = await aiActionService.propose(
            { userId: brokerA.userId, role: "Broker" },
            draft
        );
        assert.equal(action.actionType, "REQUEST_DOCUMENT");
        assert.equal(action.status, "PENDING_CONFIRMATION");
        assert.equal(action.requiresConfirmation, true);
    } finally {
        await prisma.aiAction
            .deleteMany({ where: { targetId: shipment.shipmentLeadId } })
            .catch(() => null);
        await prisma.shipmentLead
            .delete({ where: { shipmentLeadId: shipment.shipmentLeadId } })
            .catch(() => null);
        await prisma.auditLog
            .deleteMany({ where: { userId: { in: [brokerA.userId, brokerB.userId] } } })
            .catch(() => null);
        await prisma.user
            .deleteMany({ where: { userId: { in: [brokerA.userId, brokerB.userId] } } })
            .catch(() => null);
    }
});
