import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../config/database.js";
import { aiActionService } from "./actions/action.service.js";
import { proposalsFromOperationalRecommendations } from "./actions/proposals.js";
import { communicationService, _commTestUtils } from "./communications/index.js";

const {
    classifyResponse,
    extractCommitment,
    classifyDirection,
    computeWaitingState,
} = _commTestUtils;

test("response classification distinguishes positive, negative, uncertain, and no response", () => {
    assert.equal(classifyResponse("Yes we will send it tomorrow"), "POSITIVE_RESPONSE");
    assert.equal(classifyResponse("We cannot provide that"), "NEGATIVE_RESPONSE");
    assert.equal(classifyResponse("Checking with dispatch"), "UNCERTAIN");
    assert.equal(classifyResponse(""), "NO_RESPONSE");
    assert.notEqual(classifyResponse(""), "NEGATIVE_RESPONSE");
});

test("commitment extracts only explicit promises and dates", () => {
    const now = new Date("2026-08-23T12:00:00.000Z");
    assert.deepEqual(extractCommitment("We will send the COI tomorrow", now), {
        subject: "send the COI tomorrow",
        promisedDate: "2026-08-24",
    });
    assert.deepEqual(extractCommitment("We will send the COI", now), {
        subject: "send the COI",
        promisedDate: null,
    });
    assert.deepEqual(extractCommitment("The COI may be available soon", now), {
        subject: null,
        promisedDate: null,
    });
});

test("direction is deterministic and unknown mailbox participants are inbound", () => {
    const ctx = {
        brokerEmails: new Set(["broker@example.com"]),
        carrierEmails: new Set(["carrier@example.com"]),
        customerEmails: new Set(["customer@example.com"]),
    };
    assert.equal(classifyDirection("Broker <broker@example.com>", ctx), "OUTBOUND");
    assert.equal(classifyDirection("carrier@example.com", ctx), "INBOUND");
    assert.equal(classifyDirection("unknown@example.com", ctx), "INBOUND");
});

test("Golden A: executed document request without response waits for document", () => {
    const state = computeWaitingState({
        actions: [{
            actionId: "a1",
            actionType: "REQUEST_DOCUMENT",
            status: "EXECUTED",
            executedAt: "2026-08-20T10:00:00Z",
            documentType: "COI",
        }],
        documents: [],
        messages: [],
    });
    assert.equal(state.waitingFor, "WAITING_FOR_DOCUMENT");
    assert.equal(state.waitingSince, "2026-08-20T10:00:00.000Z");
    assert.equal(state.openRequests[0].responseClass, "NO_RESPONSE");
});

test("received document resolves matching request", () => {
    const state = computeWaitingState({
        actions: [{
            actionId: "a1",
            actionType: "REQUEST_DOCUMENT",
            status: "EXECUTED",
            executedAt: "2026-08-20T10:00:00Z",
            documentType: "NOA",
        }],
        documents: [{
            documentId: "d1",
            documentType: "NOA",
            status: "CURRENT",
            uploadedAt: "2026-08-21T10:00:00Z",
        }],
        messages: [],
    });
    assert.equal(state.waitingFor, "NO_OUTSTANDING_WAIT");
    assert.equal(state.openRequests.length, 0);
});

test("negative response is recorded as response, not no-response", () => {
    const state = computeWaitingState({
        actions: [{
            actionId: "a1",
            actionType: "REQUEST_DOCUMENT",
            status: "EXECUTED",
            executedAt: "2026-08-20T10:00:00Z",
            documentType: "W9",
        }],
        documents: [],
        messages: [{
            id: "m1",
            direction: "INBOUND",
            at: "2026-08-21T10:00:00Z",
            snippet: "We do not have it",
        }],
    });
    assert.equal(state.openRequests[0].lifecycle, "RESPONDED");
    assert.equal(state.openRequests[0].responseClass, "NEGATIVE_RESPONSE");
});

test("incomplete evidence and missing timestamps never invent dates", () => {
    const incomplete = computeWaitingState({
        actions: [],
        documents: [],
        messages: [],
        incomplete: true,
    });
    assert.equal(incomplete.waitingFor, "INCOMPLETE");
    assert.equal(incomplete.waitingSince, null);
    const missing = computeWaitingState({
        actions: [{
            actionId: "a-no-time",
            actionType: "REQUEST_DOCUMENT",
            status: "EXECUTED",
            executedAt: null,
            documentType: "COI",
        }],
        documents: [],
        messages: [],
    });
    assert.equal(missing.waitingSince, null);
    assert.match(missing.unresolvedItems[0], /no execution timestamp/i);
});

test("recent inbound reply prevents follow-up waiting state", () => {
    const state = computeWaitingState({
        actions: [],
        documents: [],
        messages: [
            { id: "out", direction: "OUTBOUND", at: "2026-08-20T10:00:00Z" },
            { id: "in", direction: "INBOUND", at: "2026-08-21T10:00:00Z" },
        ],
    });
    assert.equal(state.waitingFor, "NO_OUTSTANDING_WAIT");
});

async function withCarrierFixture(
    fn: (fixture: { brokerA: string; brokerB: string; carrierId: string; email: string }) => Promise<void>
) {
    const role = await prisma.role.upsert({
        where: { roleName: "Broker" },
        update: {},
        create: { roleName: "Broker", description: "Broker" },
    });
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const brokerA = await prisma.user.create({
        data: {
            username: `p7a_${suffix}`,
            email: `p7a-${suffix}@example.invalid`,
            passwordHash: "x",
            firstName: "A",
            lastName: "P7",
            roleId: role.roleId,
            isActive: true,
        },
    });
    const brokerB = await prisma.user.create({
        data: {
            username: `p7b_${suffix}`,
            email: `p7b-${suffix}@example.invalid`,
            passwordHash: "x",
            firstName: "B",
            lastName: "P7",
            roleId: role.roleId,
            isActive: true,
        },
    });
    const email = `p7-${suffix}@example.invalid`;
    const carrier = await prisma.carrier.create({
        data: {
            legalName: `P7 Carrier ${suffix}`,
            email,
            mcNumber: `7${String(Date.now()).slice(-6)}`,
            assignedBrokerId: brokerA.userId,
            status: "ACTIVE",
            onboardingStatus: "APPROVED",
        },
    });
    try {
        await fn({
            brokerA: brokerA.userId,
            brokerB: brokerB.userId,
            carrierId: carrier.carrierId,
            email,
        });
    } finally {
        await prisma.aiAction.deleteMany({ where: { targetId: carrier.carrierId } }).catch(() => null);
        await prisma.carrier.delete({ where: { carrierId: carrier.carrierId } }).catch(() => null);
        await prisma.auditLog.deleteMany({ where: { userId: { in: [brokerA.userId, brokerB.userId] } } }).catch(() => null);
        await prisma.user.deleteMany({ where: { userId: { in: [brokerA.userId, brokerB.userId] } } }).catch(() => null);
    }
}

test("carrier communication ACL rejects another broker", async () => {
    await withCarrierFixture(async ({ brokerB, carrierId }) => {
        await assert.rejects(
            communicationService.carrierCommunications(
                { userId: brokerB, role: "Broker" },
                carrierId
            ),
            (error: unknown) => (error as { status?: number }).status === 403
        );
    });
});

test("communication recommendation proposal remains confirmation-gated", async () => {
    await withCarrierFixture(async ({ brokerA, carrierId, email }) => {
        const draft = proposalsFromOperationalRecommendations({
            carrierId,
            carrierEmail: email,
            recommendations: [{
                id: "comm-followup-coi",
                text: "Follow up for COI",
                reason: "COI was requested and has not been received",
                priority: "HIGH",
            }],
        })[0];
        assert.equal(draft.actionType, "SEND_EMAIL");
        const action = await aiActionService.propose(
            { userId: brokerA, role: "Broker" },
            draft
        );
        assert.equal(action.status, "PENDING_CONFIRMATION");
        assert.equal(action.requiresConfirmation, true);
    });
});
