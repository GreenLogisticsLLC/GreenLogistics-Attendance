import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../../config/database.js";
import { assertShipmentAccessOrThrow } from "../../auth/access.js";
import {
    assertRateConfirmationCompliance,
    enqueueLoadDocumentAi,
} from "../shipment/services/load-documents.service.js";
import { buildLoadQuickActions } from "../shipment/load-quick-actions.js";
import { _lifecycleTestUtils } from "./lifecycle/service.js";
import type { DocumentChecklistItem } from "./operational/types.js";
import type { LifecycleEvidence } from "./lifecycle/types.js";
import { proposalsFromOperationalRecommendations } from "./actions/proposals.js";
import { aiActionService } from "./actions/action.service.js";

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

test("Phase 10 RC compliance gate blocks RED carriers", () => {
    assert.throws(
        () =>
            assertRateConfirmationCompliance(
                {
                    readiness: "NOT_READY",
                    compliance: { light: "RED", summary: "Insurance expired" },
                },
                true
            ),
        (error: unknown) =>
            (error as { status?: number; code?: string }).status === 422 &&
            (error as { code?: string }).code === "RC_COMPLIANCE_BLOCKED"
    );
});

test("Phase 10 closeout checklist rejects unsigned POD", () => {
    const checklist = _lifecycleTestUtils.buildCloseoutChecklist({
        status: "POD_UPLOADED",
        carrierCompliance: { readiness: "READY", light: "GREEN" },
        documents: [
            doc("RATE_CONFIRMATION", "PRESENT"),
            doc("BOL", "PRESENT"),
            doc("POD", "REVIEW_REQUIRED", { signatureStatus: "RECEIVER:UNSIGNED" }),
        ],
        loadDocuments: [
            { docType: "RATE_CONFIRMATION" },
            { docType: "BOL" },
            {
                docType: "POD",
                contentJson: JSON.stringify({ receiverSignatureDetected: false }),
            },
        ],
        customerPaidAt: new Date(),
        carrierPaidAt: new Date(),
        reviewCustomerSentAt: new Date(),
    });
    assert.equal(checklist.find((item) => item.id === "pod_signature")?.ok, false);
    assert.equal(
        checklist.filter((item) => item.required).every((item) => item.ok),
        false
    );
});

test("READY_TO_CLOSE remains a manual recommendation and never mutates status", () => {
    const evidence: LifecycleEvidence = {
        status: "COMPLETED",
        closeoutReadiness: "READY_TO_CLOSE",
    };
    const stage = _lifecycleTestUtils.deriveCurrentStage(evidence);
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

test("transit and delivery quick actions unlock sequentially", () => {
    const base = {
        carrierName: "Test Carrier",
        carrierOnboardingStatus: "APPROVED",
        documents: [{ docType: "RATE_CONFIRMATION" }, { docType: "BOL" }],
    };
    const afterPickup = buildLoadQuickActions({ ...base, status: "PICKUP" });
    assert.equal(afterPickup.find((action) => action.id === "mark_transit")?.state, "current");
    assert.equal(afterPickup.find((action) => action.id === "mark_delivered")?.state, "locked");
    const inTransit = buildLoadQuickActions({ ...base, status: "IN_TRANSIT" });
    assert.equal(inTransit.find((action) => action.id === "mark_delivered")?.state, "current");
});

test("RC/BOL Document AI enqueue helper invokes the existing queue", async () => {
    let called = 0;
    enqueueLoadDocumentAi(
        {
            actor: { userId: "broker", role: "Broker" },
            documentSource: "LOAD",
            documentId: "document",
        },
        async () => {
            called += 1;
            return { jobId: "job", status: "QUEUED" };
        }
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(called, 1);
});

test("missing POD requests a document and absent tracking remains absent", () => {
    const evidence: LifecycleEvidence = {
        status: "DELIVERED",
        documents: [doc("RATE_CONFIRMATION", "PRESENT"), doc("BOL", "PRESENT"), doc("POD", "MISSING")],
        closeoutReadiness: "NOT_READY",
        tracking: null,
    };
    const stage = _lifecycleTestUtils.deriveCurrentStage(evidence);
    const issues = _lifecycleTestUtils.deriveLifecycleIssues(evidence, stage);
    assert.equal(
        _lifecycleTestUtils.deriveNextBestAction({ stage, evidence, ...issues }),
        "REQUEST_DOCUMENT"
    );
    assert.equal(_lifecycleTestUtils.trackingView(null), null);
});

test("Phase 10 lifecycle ACL remains broker-scoped and Phase 6 stays confirmation-gated", async () => {
    const role = await prisma.role.upsert({
        where: { roleName: "Broker" },
        update: {},
        create: { roleName: "Broker", description: "Broker" },
    });
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const brokerA = await prisma.user.create({
        data: {
            username: `p10a_${suffix}`,
            email: `p10a-${suffix}@example.invalid`,
            passwordHash: "x",
            firstName: "A",
            lastName: "Phase10",
            roleId: role.roleId,
            isActive: true,
        },
    });
    const brokerB = await prisma.user.create({
        data: {
            username: `p10b_${suffix}`,
            email: `p10b-${suffix}@example.invalid`,
            passwordHash: "x",
            firstName: "B",
            lastName: "Phase10",
            roleId: role.roleId,
            isActive: true,
        },
    });
    const shipment = await prisma.shipmentLead.create({
        data: {
            source: "PHASE10_TEST",
            shipmentTitle: `Phase 10 ${suffix}`,
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
        const proposal = proposalsFromOperationalRecommendations({
            shipmentLeadId: shipment.shipmentLeadId,
            recommendations: [
                {
                    id: "req-pod",
                    text: "Request POD document from carrier",
                    reason: "POD missing",
                    priority: "HIGH",
                },
            ],
        })[0];
        const action = await aiActionService.propose(
            { userId: brokerA.userId, role: "Broker" },
            proposal
        );
        assert.equal(action.actionType, "REQUEST_DOCUMENT");
        assert.equal(action.status, "PENDING_CONFIRMATION");
        assert.equal(action.requiresConfirmation, true);
    } finally {
        await prisma.aiAction.deleteMany({ where: { targetId: shipment.shipmentLeadId } }).catch(() => null);
        await prisma.shipmentLead.delete({ where: { shipmentLeadId: shipment.shipmentLeadId } }).catch(() => null);
        await prisma.auditLog.deleteMany({ where: { userId: { in: [brokerA.userId, brokerB.userId] } } }).catch(() => null);
        await prisma.user.deleteMany({ where: { userId: { in: [brokerA.userId, brokerB.userId] } } }).catch(() => null);
    }
});
