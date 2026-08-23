import { prisma } from "../../../config/database.js";
import {
    AI_ACTION_TARGET_TYPES,
    AI_ACTION_TTL_MINUTES,
    isAllowedActionType,
    isBlockedActionType,
    type AiActionStatus,
    type AiActionTargetType,
    type AiActionType,
} from "./constants.js";
import {
    assertActionTargetAccess,
    assertActionActor,
    hashPayload,
    newIdempotencyKey,
    actionError,
    writeAiActionAudit,
} from "./acl.js";
import {
    checkStaleForRequestDocument,
    executeCreateFollowUp,
    executeCreateInternalNote,
    executeMarkReviewRequired,
    executeRequestDocument,
    executeSendEmail,
} from "./executors.js";
import type {
    AiActionActor,
    AiActionPayload,
    AiActionPublicView,
    ConfirmAiActionResult,
    ProposeAiActionInput,
} from "./types.js";

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

function toPublic(row: {
    actionId: string;
    actionType: string;
    status: string;
    title: string;
    description: string | null;
    reason: string | null;
    targetType: string;
    targetId: string | null;
    payloadJson: string;
    sourcesJson: string | null;
    expiresAt: Date;
    createdAt: Date;
    confirmedAt: Date | null;
    executedAt: Date | null;
    resultJson: string | null;
    errorMessage: string | null;
    aiRunId: string | null;
}): AiActionPublicView {
    return {
        actionId: row.actionId,
        actionType: row.actionType as AiActionType,
        status: row.status as AiActionStatus,
        title: row.title,
        description: row.description,
        reason: row.reason,
        target: {
            type: row.targetType as AiActionTargetType,
            id: row.targetId,
        },
        requiresConfirmation: true,
        payload: parseJson<AiActionPayload>(row.payloadJson, {}),
        sources: parseJson(row.sourcesJson, []),
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        confirmedAt: row.confirmedAt?.toISOString() ?? null,
        executedAt: row.executedAt?.toISOString() ?? null,
        result: parseJson(row.resultJson, null),
        errorMessage: row.errorMessage,
        aiRunId: row.aiRunId,
    };
}

async function runExecutor(
    actor: AiActionActor,
    actionType: AiActionType,
    targetType: string,
    targetId: string | null,
    payload: AiActionPayload
): Promise<Record<string, unknown>> {
    switch (actionType) {
        case "SEND_EMAIL":
            return executeSendEmail(actor, targetType, targetId, payload);
        case "CREATE_INTERNAL_NOTE":
            return executeCreateInternalNote(actor, targetType, targetId, payload);
        case "CREATE_FOLLOW_UP":
            return executeCreateFollowUp(actor, targetType, targetId, payload);
        case "REQUEST_DOCUMENT":
            return executeRequestDocument(actor, targetType, targetId, payload);
        case "MARK_REVIEW_REQUIRED":
            return executeMarkReviewRequired(actor, targetType, targetId, payload);
        default:
            throw actionError(`Unsupported action type: ${actionType}`, 422, "INVALID_ACTION_TYPE");
    }
}

/**
 * Phase 6 AI Actions service.
 * LLM may only propose. Execution requires explicit user confirmation.
 */
export class AiActionService {
    async propose(
        actor: AiActionActor,
        input: ProposeAiActionInput
    ): Promise<AiActionPublicView> {
        assertActionActor(actor);
        if (isBlockedActionType(input.actionType)) {
            throw actionError(
                `Action type ${input.actionType} is not allowed in Phase 6`,
                422,
                "ACTION_BLOCKED"
            );
        }
        if (!isAllowedActionType(input.actionType)) {
            throw actionError("Invalid action type", 422, "INVALID_ACTION_TYPE");
        }
        if (!(AI_ACTION_TARGET_TYPES as readonly string[]).includes(input.targetType)) {
            throw actionError("Invalid target type", 422, "INVALID_TARGET");
        }
        if (!input.title || !String(input.title).trim()) {
            throw actionError("Action title is required", 422, "INVALID_PAYLOAD");
        }
        if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
            throw actionError("Action payload must be an object", 422, "INVALID_PAYLOAD");
        }

        await assertActionTargetAccess(actor, input.targetType, input.targetId);

        const payload = input.payload || {};
        const payloadHash = hashPayload(payload);
        const ttl = input.ttlMinutes ?? AI_ACTION_TTL_MINUTES;
        const expiresAt = new Date(Date.now() + ttl * 60_000);

        const row = await prisma.aiAction.create({
            data: {
                actorUserId: actor.userId,
                actionType: input.actionType,
                status: "PENDING_CONFIRMATION",
                title: String(input.title || input.actionType).slice(0, 200),
                description: input.description?.slice(0, 2000) || null,
                reason: input.reason?.slice(0, 2000) || null,
                targetType: input.targetType,
                targetId: input.targetId || null,
                payloadJson: JSON.stringify(payload),
                sourcesJson: JSON.stringify(input.sources || []),
                aiRunId: input.aiRunId || null,
                idempotencyKey: newIdempotencyKey(),
                payloadHash,
                groundingHash: input.groundingHash || null,
                expiresAt,
            },
        });

        await writeAiActionAudit({
            userId: actor.userId,
            action: "PROPOSED",
            entityId: row.actionId,
            newValue: JSON.stringify({
                actionType: row.actionType,
                targetType: row.targetType,
                targetId: row.targetId,
                status: row.status,
            }),
        });

        return toPublic(row);
    }

    async get(actor: AiActionActor, actionId: string): Promise<AiActionPublicView> {
        assertActionActor(actor);
        const row = await prisma.aiAction.findUnique({ where: { actionId } });
        if (!row) throw actionError("Action not found", 404, "NOT_FOUND");
        if (
            row.actorUserId !== actor.userId &&
            !["Administrator", "Owner", "Manager"].includes(actor.role)
        ) {
            throw actionError("Access denied", 403, "ACTION_FORBIDDEN");
        }
        return toPublic(row);
    }

    async cancel(actor: AiActionActor, actionId: string): Promise<AiActionPublicView> {
        assertActionActor(actor);
        const row = await prisma.aiAction.findUnique({ where: { actionId } });
        if (!row) throw actionError("Action not found", 404, "NOT_FOUND");
        if (row.actorUserId !== actor.userId) {
            throw actionError(
                "Only the proposing user may cancel this action",
                403,
                "ACTION_FORBIDDEN"
            );
        }
        if (row.status === "EXECUTED" || row.status === "ALREADY_EXECUTED") {
            throw actionError("Executed actions cannot be cancelled", 409, "ALREADY_EXECUTED");
        }
        if (row.status === "CANCELLED") return toPublic(row);
        if (row.status !== "PENDING_CONFIRMATION" && row.status !== "CONFIRMED") {
            throw actionError(
                `Action cannot be cancelled from status ${row.status}`,
                409,
                "INVALID_STATUS"
            );
        }

        const updated = await prisma.aiAction.update({
            where: { actionId },
            data: { status: "CANCELLED", cancelledAt: new Date() },
        });

        await writeAiActionAudit({
            userId: actor.userId,
            action: "CANCELLED",
            entityId: actionId,
            oldValue: row.status,
            newValue: "CANCELLED",
        });

        return toPublic(updated);
    }

    async confirm(actor: AiActionActor, actionId: string): Promise<ConfirmAiActionResult> {
        assertActionActor(actor);
        const row = await prisma.aiAction.findUnique({ where: { actionId } });
        if (!row) throw actionError("Action not found", 404, "NOT_FOUND");

        if (row.actorUserId !== actor.userId) {
            throw actionError(
                "Only the proposing user may confirm this action",
                403,
                "ACTION_FORBIDDEN"
            );
        }

        if (row.status === "EXECUTED" || row.status === "ALREADY_EXECUTED") {
            return {
                status: "ALREADY_EXECUTED",
                action: toPublic({ ...row, status: "ALREADY_EXECUTED" }),
                execution: parseJson(row.resultJson, undefined),
            };
        }

        if (row.status === "CANCELLED") {
            throw actionError("Action was cancelled", 409, "ACTION_CANCELLED");
        }

        if (row.status === "FAILED") {
            throw actionError(
                "Action previously failed — create a new proposal",
                409,
                "ACTION_FAILED"
            );
        }

        if (row.expiresAt.getTime() < Date.now()) {
            await prisma.aiAction.update({
                where: { actionId },
                data: { status: "EXPIRED" },
            });
            throw actionError("Action proposal has expired", 409, "ACTION_EXPIRED");
        }

        if (row.status !== "PENDING_CONFIRMATION" && row.status !== "CONFIRMED") {
            throw actionError(
                `Action cannot be confirmed from status ${row.status}`,
                409,
                "INVALID_STATUS"
            );
        }

        await assertActionTargetAccess(
            actor,
            row.targetType as AiActionTargetType,
            row.targetId
        );

        const payload = parseJson<AiActionPayload>(row.payloadJson, {});
        if (hashPayload(payload) !== row.payloadHash) {
            throw actionError("Action payload integrity check failed", 409, "PAYLOAD_TAMPERED");
        }

        if (row.actionType === "REQUEST_DOCUMENT") {
            await checkStaleForRequestDocument(
                row.targetType,
                row.targetId,
                String(payload.documentType || payload.docType || "")
            );
        }

        const claimed = await prisma.aiAction.updateMany({
            where: {
                actionId,
                status: { in: ["PENDING_CONFIRMATION", "CONFIRMED"] },
            },
            data: {
                status: "EXECUTING",
                confirmedAt: row.confirmedAt || new Date(),
            },
        });

        if (claimed.count === 0) {
            const again = await prisma.aiAction.findUnique({ where: { actionId } });
            if (again && (again.status === "EXECUTED" || again.status === "ALREADY_EXECUTED")) {
                return {
                    status: "ALREADY_EXECUTED",
                    action: toPublic({ ...again, status: "ALREADY_EXECUTED" }),
                    execution: parseJson(again.resultJson, undefined),
                };
            }
            throw actionError("Action is not available for confirmation", 409, "INVALID_STATUS");
        }

        await writeAiActionAudit({
            userId: actor.userId,
            action: "CONFIRMED",
            entityId: actionId,
            oldValue: row.status,
            newValue: "EXECUTING",
        });

        try {
            const execution = await runExecutor(
                actor,
                row.actionType as AiActionType,
                row.targetType,
                row.targetId,
                payload
            );

            const updated = await prisma.aiAction.update({
                where: { actionId },
                data: {
                    status: "EXECUTED",
                    executedAt: new Date(),
                    resultJson: JSON.stringify(execution),
                    errorMessage: null,
                },
            });

            await writeAiActionAudit({
                userId: actor.userId,
                action: "EXECUTED",
                entityId: actionId,
                newValue: JSON.stringify({
                    actionType: row.actionType,
                    resultKeys: Object.keys(execution),
                }),
            });

            return {
                status: "EXECUTED",
                action: toPublic(updated),
                execution,
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : "Action execution failed";
            const code =
                err && typeof err === "object" && "code" in err
                    ? String((err as { code: string }).code)
                    : "EXECUTION_FAILED";

            await prisma.aiAction.update({
                where: { actionId },
                data: {
                    status: "FAILED",
                    errorMessage: `${code}: ${message}`.slice(0, 1000),
                },
            });

            await writeAiActionAudit({
                userId: actor.userId,
                action: "FAILED",
                entityId: actionId,
                newValue: code,
            });

            throw err;
        }
    }
}

export const aiActionService = new AiActionService();
