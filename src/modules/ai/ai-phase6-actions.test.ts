/**
 * Phase 6 — AI Actions Foundation security & golden scenario tests.
 * Email sends are mocked — never hits production SMTP/Gmail.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../config/database.js";
import { aiActionService } from "./actions/action.service.js";
import {
    AI_ACTION_TYPES,
    BLOCKED_ACTION_TYPES,
    isAllowedActionType,
    isBlockedActionType,
    isSensitiveDocType,
} from "./actions/constants.js";
import { hashPayload } from "./actions/acl.js";
import { proposalsFromOperationalRecommendations } from "./actions/proposals.js";
import {
    _setAiActionEmailSendForTests,
    executeSendEmail,
    resolveAuthorizedRecipient,
} from "./actions/executors.js";
import { _aiOrchestratorTestUtils } from "./services/ai-orchestrator.js";

const { GROUNDED_SYSTEM } = _aiOrchestratorTestUtils;

test("allowed / blocked action types", () => {
    for (const t of AI_ACTION_TYPES) assert.equal(isAllowedActionType(t), true);
    for (const t of BLOCKED_ACTION_TYPES) {
        assert.equal(isBlockedActionType(t), true);
        assert.equal(isAllowedActionType(t), false);
    }
    assert.equal(isAllowedActionType("DELETE_DOCUMENT"), false);
    assert.equal(isBlockedActionType("CHANGE_RATE"), true);
});

test("sensitive attachment types rejected", () => {
    assert.equal(isSensitiveDocType("W9"), true);
    assert.equal(isSensitiveDocType("W-9"), true);
    assert.equal(isSensitiveDocType("TIN"), true);
    assert.equal(isSensitiveDocType("COI"), false);
    assert.equal(isSensitiveDocType("NOA"), false);
});

test("payload hash is deterministic", () => {
    const a = hashPayload({ to: "a@b.com", subject: "x" });
    const b = hashPayload({ to: "a@b.com", subject: "x" });
    const c = hashPayload({ to: "a@b.com", subject: "y" });
    const reordered = hashPayload({ subject: "x", to: "a@b.com" });
    assert.equal(a, b);
    assert.equal(a, reordered);
    assert.notEqual(a, c);
});

test("service methods require an authenticated actor", async () => {
    await assert.rejects(
        aiActionService.propose(
            { userId: "", role: "" },
            {
                actionType: "CREATE_INTERNAL_NOTE",
                title: "Unauthorized",
                targetType: "none",
                payload: { noteText: "must not persist" },
            }
        ),
        (err: unknown) => (err as { code?: string }).code === "UNAUTHORIZED"
    );
});

test("proposals map missing-doc recommendations to REQUEST_DOCUMENT", () => {
    const drafts = proposalsFromOperationalRecommendations({
        carrierId: "c1",
        carrierEmail: "carrier@example.com",
        recommendations: [
            {
                id: "req-noa",
                text: "Request NOA",
                reason: "NOA is missing",
                priority: "HIGH",
            },
        ],
    });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].actionType, "REQUEST_DOCUMENT");
    assert.equal(drafts[0].payload.documentType, "NOA");
    assert.ok(String(drafts[0].payload.subject).includes("NOA"));
});

test("LLM system prompt forbids claiming executed actions", () => {
    assert.match(GROUNDED_SYSTEM, /Never claim an ACTION was completed/i);
    assert.match(GROUNDED_SYSTEM, /email sent/i);
});

test("invalid action type rejected at propose", async () => {
    let threw = false;
    try {
        await aiActionService.propose(
            { userId: "u1", role: "Administrator" },
            {
                actionType: "APPROVE_CARRIER" as never,
                title: "Approve",
                targetType: "carrier",
                targetId: "x",
                payload: {},
            }
        );
    } catch (err) {
        threw = true;
        assert.equal((err as { code?: string }).code, "ACTION_BLOCKED");
    }
    assert.equal(threw, true);
});

async function withFixture(
    fn: (ctx: {
        brokerA: { userId: string };
        brokerB: { userId: string };
        carrier: { carrierId: string; email: string };
    }) => Promise<void>
) {
    const role = await prisma.role.upsert({
        where: { roleName: "Broker" },
        update: {},
        create: { roleName: "Broker", description: "Broker" },
    });
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let brokerA: { userId: string } | null = null;
    let brokerB: { userId: string } | null = null;
    let carrier: { carrierId: string; email: string } | null = null;
    const email = `p6c-${suffix}@example.invalid`;
    try {
        brokerA = await prisma.user.create({
            data: {
                username: `p6a_${suffix}`,
                email: `p6a-${suffix}@example.invalid`,
                passwordHash: "x",
                firstName: "A",
                lastName: "P6",
                roleId: role.roleId,
                isActive: true,
            },
            select: { userId: true },
        });
        brokerB = await prisma.user.create({
            data: {
                username: `p6b_${suffix}`,
                email: `p6b-${suffix}@example.invalid`,
                passwordHash: "x",
                firstName: "B",
                lastName: "P6",
                roleId: role.roleId,
                isActive: true,
            },
            select: { userId: true },
        });
        carrier = await prisma.carrier.create({
            data: {
                legalName: `P6 Carrier ${suffix} LLC`,
                email,
                mcNumber: `8${String(Date.now()).slice(-6)}`,
                assignedBrokerId: brokerA.userId,
                status: "ACTIVE",
                onboardingStatus: "APPROVED",
            },
            select: { carrierId: true, email: true },
        });
        await fn({
            brokerA,
            brokerB,
            carrier: { carrierId: carrier.carrierId, email: carrier.email || email },
        });
    } finally {
        if (carrier) {
            await prisma.aiAction
                .deleteMany({ where: { targetId: carrier.carrierId } })
                .catch(() => null);
            await prisma.carrierDocument
                .deleteMany({ where: { carrierId: carrier.carrierId } })
                .catch(() => null);
            await prisma.carrier.delete({ where: { carrierId: carrier.carrierId } }).catch(() => null);
        }
        const userIds = [brokerA?.userId, brokerB?.userId].filter(
            (id): id is string => Boolean(id)
        );
        if (userIds.length) {
            await prisma.auditLog
                .deleteMany({ where: { userId: { in: userIds }, module: "AI_ACTIONS" } })
                .catch(() => null);
            await prisma.aiAction
                .deleteMany({ where: { actorUserId: { in: userIds } } })
                .catch(() => null);
        }
        if (brokerA) await prisma.user.delete({ where: { userId: brokerA.userId } }).catch(() => null);
        if (brokerB) await prisma.user.delete({ where: { userId: brokerB.userId } }).catch(() => null);
        _setAiActionEmailSendForTests(null);
    }
}

test("unauthorized / cross-broker action propose denied", async () => {
    await withFixture(async ({ brokerB, carrier }) => {
        let denied = false;
        try {
            await aiActionService.propose(
                { userId: brokerB.userId, role: "Broker" },
                {
                    actionType: "CREATE_INTERNAL_NOTE",
                    title: "Note",
                    targetType: "carrier",
                    targetId: carrier.carrierId,
                    payload: { noteText: "cross-broker attempt" },
                }
            );
        } catch (err) {
            denied = (err as { status?: number }).status === 403;
        }
        assert.equal(denied, true);
    });
});

test("Golden A: REQUEST_DOCUMENT confirm executes (mock email)", async () => {
    await withFixture(async ({ brokerA, carrier }) => {
        let sendCount = 0;
        _setAiActionEmailSendForTests(async (input) => {
            sendCount += 1;
            assert.equal(input.to, carrier.email);
            return { via: "mock", from: "mock@test" };
        });

        const proposed = await aiActionService.propose(
            { userId: brokerA.userId, role: "Broker" },
            {
                actionType: "REQUEST_DOCUMENT",
                title: "Request NOA",
                reason: "NOA missing",
                targetType: "carrier",
                targetId: carrier.carrierId,
                payload: {
                    documentType: "NOA",
                    to: carrier.email,
                    subject: "Document request: NOA",
                    bodyText: "Please provide NOA.",
                },
                sources: [{ type: "recommendation", id: "req-noa", label: "Request NOA" }],
            }
        );
        assert.equal(proposed.status, "PENDING_CONFIRMATION");
        assert.equal(proposed.requiresConfirmation, true);

        const result = await aiActionService.confirm(
            { userId: brokerA.userId, role: "Broker" },
            proposed.actionId
        );
        assert.equal(result.status, "EXECUTED");
        assert.equal(sendCount, 1);

        const audits = await prisma.auditLog.findMany({
            where: { module: "AI_ACTIONS", entityId: proposed.actionId },
            orderBy: { createdAt: "asc" },
        });
        const actions = audits.map((a) => a.action);
        assert.ok(actions.includes("PROPOSED"));
        assert.ok(actions.includes("CONFIRMED"));
        assert.ok(actions.includes("EXECUTED"));
    });
});

test("Golden B: cancel — no email sent", async () => {
    await withFixture(async ({ brokerA, carrier }) => {
        let sendCount = 0;
        _setAiActionEmailSendForTests(async () => {
            sendCount += 1;
            return { via: "mock", from: "mock@test" };
        });
        const proposed = await aiActionService.propose(
            { userId: brokerA.userId, role: "Broker" },
            {
                actionType: "SEND_EMAIL",
                title: "Request COI",
                targetType: "carrier",
                targetId: carrier.carrierId,
                payload: {
                    to: carrier.email,
                    subject: "Updated COI",
                    bodyText: "Please send updated COI.",
                },
            }
        );
        const cancelled = await aiActionService.cancel(
            { userId: brokerA.userId, role: "Broker" },
            proposed.actionId
        );
        assert.equal(cancelled.status, "CANCELLED");
        let failed = false;
        try {
            await aiActionService.confirm(
                { userId: brokerA.userId, role: "Broker" },
                proposed.actionId
            );
        } catch (err) {
            failed = (err as { code?: string }).code === "ACTION_CANCELLED";
        }
        assert.equal(failed, true);
        assert.equal(sendCount, 0);
    });
});

test("Golden C: duplicate confirmation → ALREADY_EXECUTED, one email", async () => {
    await withFixture(async ({ brokerA, carrier }) => {
        let sendCount = 0;
        _setAiActionEmailSendForTests(async () => {
            sendCount += 1;
            return { via: "mock", from: "mock@test" };
        });
        const proposed = await aiActionService.propose(
            { userId: brokerA.userId, role: "Broker" },
            {
                actionType: "SEND_EMAIL",
                title: "Email",
                targetType: "carrier",
                targetId: carrier.carrierId,
                payload: {
                    to: carrier.email,
                    subject: "Hello",
                    bodyText: "Body",
                },
            }
        );
        const first = await aiActionService.confirm(
            { userId: brokerA.userId, role: "Broker" },
            proposed.actionId
        );
        assert.equal(first.status, "EXECUTED");
        const second = await aiActionService.confirm(
            { userId: brokerA.userId, role: "Broker" },
            proposed.actionId
        );
        assert.equal(second.status, "ALREADY_EXECUTED");
        assert.equal(sendCount, 1);
    });
});

test("Golden D: expired action cannot execute", async () => {
    await withFixture(async ({ brokerA, carrier }) => {
        const proposed = await aiActionService.propose(
            { userId: brokerA.userId, role: "Broker" },
            {
                actionType: "CREATE_INTERNAL_NOTE",
                title: "Note",
                targetType: "carrier",
                targetId: carrier.carrierId,
                payload: { noteText: "temp" },
                ttlMinutes: -1,
            }
        );
        let code = "";
        try {
            await aiActionService.confirm(
                { userId: brokerA.userId, role: "Broker" },
                proposed.actionId
            );
        } catch (err) {
            code = String((err as { code?: string }).code || "");
        }
        assert.equal(code, "ACTION_EXPIRED");
    });
});

test("Golden E: ACL re-checked at confirm — cross-user forbidden", async () => {
    await withFixture(async ({ brokerA, brokerB, carrier }) => {
        const proposed = await aiActionService.propose(
            { userId: brokerA.userId, role: "Broker" },
            {
                actionType: "CREATE_INTERNAL_NOTE",
                title: "Note",
                targetType: "carrier",
                targetId: carrier.carrierId,
                payload: { noteText: "owned by A" },
            }
        );
        let code = "";
        try {
            await aiActionService.confirm(
                { userId: brokerB.userId, role: "Broker" },
                proposed.actionId
            );
        } catch (err) {
            code = String((err as { code?: string }).code || "");
        }
        assert.equal(code, "ACTION_FORBIDDEN");
    });
});

test("Golden F: sensitive / attachments rejected", async () => {
    await withFixture(async ({ brokerA, carrier }) => {
        _setAiActionEmailSendForTests(async () => ({ via: "mock", from: "m" }));
        const doc = await prisma.carrierDocument.create({
            data: {
                carrierId: carrier.carrierId,
                documentType: "W9",
                originalFilename: "w9.pdf",
                storageKey: `test/w9-${Date.now()}.pdf`,
                mimeType: "application/pdf",
                fileSize: 1,
                status: "CURRENT",
                version: 1,
            },
            select: { documentId: true },
        });
        let code = "";
        try {
            await executeSendEmail(
                { userId: brokerA.userId, role: "Broker" },
                "carrier",
                carrier.carrierId,
                {
                    to: carrier.email,
                    subject: "Docs",
                    bodyText: "See attached",
                    attachmentDocumentIds: [doc.documentId],
                }
            );
        } catch (err) {
            code = String((err as { code?: string }).code || "");
        }
        assert.ok(
            code === "SENSITIVE_ATTACHMENT_REJECTED" || code === "ATTACHMENTS_NOT_SUPPORTED"
        );
    });
});

test("Golden G: proposal status stays PENDING until confirm — LLM cannot fabricate EXECUTED", async () => {
    await withFixture(async ({ brokerA, carrier }) => {
        const proposed = await aiActionService.propose(
            { userId: brokerA.userId, role: "Broker" },
            {
                actionType: "CREATE_INTERNAL_NOTE",
                title: "Note",
                targetType: "carrier",
                targetId: carrier.carrierId,
                payload: { noteText: "grounded note" },
            }
        );
        assert.equal(proposed.status, "PENDING_CONFIRMATION");
        assert.notEqual(proposed.status, "EXECUTED");
        const got = await aiActionService.get(
            { userId: brokerA.userId, role: "Broker" },
            proposed.actionId
        );
        assert.equal(got.status, "PENDING_CONFIRMATION");
        assert.equal(got.requiresConfirmation, true);
    });
});

test("unauthorized email recipient requires review", async () => {
    await withFixture(async ({ carrier }) => {
        let code = "";
        try {
            await resolveAuthorizedRecipient({
                targetType: "carrier",
                targetId: carrier.carrierId,
                proposedTo: "attacker@evil.example",
            });
        } catch (err) {
            code = String((err as { code?: string }).code || "");
        }
        assert.equal(code, "REQUIRES_REVIEW");
    });
});

test("missing recipient on carrier with no email", async () => {
    await withFixture(async ({ brokerA, carrier }) => {
        await prisma.carrier.update({
            where: { carrierId: carrier.carrierId },
            data: { email: "" },
        });
        let code = "";
        try {
            await resolveAuthorizedRecipient({
                targetType: "carrier",
                targetId: carrier.carrierId,
            });
        } catch (err) {
            code = String((err as { code?: string }).code || "");
        }
        assert.equal(code, "REQUIRES_REVIEW");
        // restore for cleanup email field not needed
        void brokerA;
    });
});

test("stale REQUEST_DOCUMENT when doc already present", async () => {
    await withFixture(async ({ brokerA, carrier }) => {
        await prisma.carrierDocument.create({
            data: {
                carrierId: carrier.carrierId,
                documentType: "NOA",
                originalFilename: "noa.pdf",
                storageKey: `test/noa-${Date.now()}.pdf`,
                mimeType: "application/pdf",
                fileSize: 1,
                status: "CURRENT",
                version: 1,
            },
        });
        const proposed = await aiActionService.propose(
            { userId: brokerA.userId, role: "Broker" },
            {
                actionType: "REQUEST_DOCUMENT",
                title: "Request NOA",
                targetType: "carrier",
                targetId: carrier.carrierId,
                payload: {
                    documentType: "NOA",
                    to: carrier.email,
                    subject: "NOA",
                    bodyText: "Please send NOA",
                },
            }
        );
        let code = "";
        try {
            await aiActionService.confirm(
                { userId: brokerA.userId, role: "Broker" },
                proposed.actionId
            );
        } catch (err) {
            code = String((err as { code?: string }).code || "");
        }
        assert.equal(code, "STALE_ACTION");
    });
});

test("CREATE_INTERNAL_NOTE executes and audits", async () => {
    await withFixture(async ({ brokerA, carrier }) => {
        const proposed = await aiActionService.propose(
            { userId: brokerA.userId, role: "Broker" },
            {
                actionType: "CREATE_INTERNAL_NOTE",
                title: "Internal note",
                reason: "Compliance follow-up",
                targetType: "carrier",
                targetId: carrier.carrierId,
                payload: { noteText: "Carrier requires updated NOA." },
                sources: [{ type: "recommendation", id: "n1", label: "note" }],
            }
        );
        const result = await aiActionService.confirm(
            { userId: brokerA.userId, role: "Broker" },
            proposed.actionId
        );
        assert.equal(result.status, "EXECUTED");
        const updated = await prisma.carrier.findUnique({
            where: { carrierId: carrier.carrierId },
            select: { notes: true },
        });
        assert.match(String(updated?.notes || ""), /requires updated NOA/);
    });
});

test("ACL checked at execution time after broker reassignment", async () => {
    await withFixture(async ({ brokerA, brokerB, carrier }) => {
        const proposed = await aiActionService.propose(
            { userId: brokerA.userId, role: "Broker" },
            {
                actionType: "CREATE_INTERNAL_NOTE",
                title: "Note",
                targetType: "carrier",
                targetId: carrier.carrierId,
                payload: { noteText: "will lose access" },
            }
        );
        await prisma.carrier.update({
            where: { carrierId: carrier.carrierId },
            data: { assignedBrokerId: brokerB.userId },
        });
        let code = "";
        try {
            await aiActionService.confirm(
                { userId: brokerA.userId, role: "Broker" },
                proposed.actionId
            );
        } catch (err) {
            code = String((err as { code?: string }).code || "");
            // assertCarrierAccess throws status 403 without ACTION_FORBIDDEN code
            if (!code && (err as { status?: number }).status === 403) {
                code = "ACTION_FORBIDDEN";
            }
        }
        assert.ok(code === "ACTION_FORBIDDEN" || code === "");
        // Prefer explicit forbid; if carrierService throws plain 403, still no execution:
        const row = await prisma.aiAction.findUnique({ where: { actionId: proposed.actionId } });
        assert.notEqual(row?.status, "EXECUTED");
    });
});

test("payload integrity is checked again at confirm", async () => {
    await withFixture(async ({ brokerA, carrier }) => {
        const proposed = await aiActionService.propose(
            { userId: brokerA.userId, role: "Broker" },
            {
                actionType: "CREATE_INTERNAL_NOTE",
                title: "Integrity",
                targetType: "carrier",
                targetId: carrier.carrierId,
                payload: { noteText: "original" },
            }
        );
        await prisma.aiAction.update({
            where: { actionId: proposed.actionId },
            data: { payloadJson: JSON.stringify({ noteText: "tampered" }) },
        });
        await assert.rejects(
            aiActionService.confirm(
                { userId: brokerA.userId, role: "Broker" },
                proposed.actionId
            ),
            (err: unknown) => (err as { code?: string }).code === "PAYLOAD_TAMPERED"
        );
    });
});

test("bad recipient is rejected at execution and no email is sent", async () => {
    await withFixture(async ({ brokerA, carrier }) => {
        let sends = 0;
        _setAiActionEmailSendForTests(async () => {
            sends += 1;
            return { via: "mock", from: "mock@test" };
        });
        const proposed = await aiActionService.propose(
            { userId: brokerA.userId, role: "Broker" },
            {
                actionType: "SEND_EMAIL",
                title: "Unsafe recipient",
                targetType: "carrier",
                targetId: carrier.carrierId,
                payload: {
                    to: "attacker@evil.example",
                    subject: "Subject",
                    bodyText: "Body",
                },
            }
        );
        await assert.rejects(
            aiActionService.confirm(
                { userId: brokerA.userId, role: "Broker" },
                proposed.actionId
            ),
            (err: unknown) => (err as { code?: string }).code === "REQUIRES_REVIEW"
        );
        assert.equal(sends, 0);
    });
});

test("CREATE_FOLLOW_UP updates shipment status and AI notes", async () => {
    await withFixture(async ({ brokerA }) => {
        const shipment = await prisma.shipmentLead.create({
            data: {
                source: "PHASE6_TEST",
                shipmentTitle: "Phase 6 follow-up",
                assignedBrokerId: brokerA.userId,
                status: "NEW",
            },
            select: { shipmentLeadId: true },
        });
        try {
            const proposed = await aiActionService.propose(
                { userId: brokerA.userId, role: "Broker" },
                {
                    actionType: "CREATE_FOLLOW_UP",
                    title: "Follow up",
                    targetType: "shipment",
                    targetId: shipment.shipmentLeadId,
                    payload: { noteText: "Call carrier tomorrow" },
                }
            );
            const result = await aiActionService.confirm(
                { userId: brokerA.userId, role: "Broker" },
                proposed.actionId
            );
            assert.equal(result.status, "EXECUTED");
            const updated = await prisma.shipmentLead.findUnique({
                where: { shipmentLeadId: shipment.shipmentLeadId },
                select: { status: true, aiNotes: true },
            });
            assert.equal(updated?.status, "FOLLOW_UP");
            assert.match(String(updated?.aiNotes), /Call carrier tomorrow/);
        } finally {
            await prisma.aiAction.deleteMany({
                where: { targetType: "shipment", targetId: shipment.shipmentLeadId },
            });
            await prisma.shipmentLead.delete({
                where: { shipmentLeadId: shipment.shipmentLeadId },
            });
        }
    });
});

test("MARK_REVIEW_REQUIRED changes only the validation review flag", async () => {
    await withFixture(async ({ brokerA, carrier }) => {
        const job = await prisma.aiDocumentJob.create({
            data: {
                documentSource: "CARRIER",
                documentId: `phase6-${Date.now()}`,
                carrierId: carrier.carrierId,
                actorUserId: brokerA.userId,
                checksum: `phase6-${Date.now()}-${Math.random()}`,
                status: "SUCCEEDED",
            },
            select: { jobId: true },
        });
        await prisma.documentValidationResult.create({
            data: {
                jobId: job.jobId,
                overallStatus: "VALID",
                trafficLight: "GREEN",
                requiresReview: false,
                reviewDecision: "APPROVED",
                reviewNotes: "existing human decision",
            },
        });
        try {
            const proposed = await aiActionService.propose(
                { userId: brokerA.userId, role: "Broker" },
                {
                    actionType: "MARK_REVIEW_REQUIRED",
                    title: "Require review",
                    targetType: "document_job",
                    targetId: job.jobId,
                    payload: { jobId: job.jobId, notes: "AI suggestion" },
                }
            );
            await aiActionService.confirm(
                { userId: brokerA.userId, role: "Broker" },
                proposed.actionId
            );
            const validation = await prisma.documentValidationResult.findUnique({
                where: { jobId: job.jobId },
            });
            assert.equal(validation?.requiresReview, true);
            assert.equal(validation?.overallStatus, "VALID");
            assert.equal(validation?.reviewDecision, "APPROVED");
            assert.equal(validation?.reviewNotes, "existing human decision");
        } finally {
            await prisma.aiAction.deleteMany({
                where: { targetType: "document_job", targetId: job.jobId },
            });
            await prisma.aiDocumentJob.delete({ where: { jobId: job.jobId } });
        }
    });
});
