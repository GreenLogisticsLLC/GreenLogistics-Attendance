import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../../config/database.js";
import { assertShipmentAccessOrThrow } from "../../../auth/access.js";
import { carrierService } from "../../carriers/services/carrier.service.js";
import type { AiActionActor } from "./types.js";
import type { AiActionTargetType } from "./constants.js";

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        return Object.keys(value as Record<string, unknown>)
            .sort()
            .reduce<Record<string, unknown>>((out, key) => {
                const item = (value as Record<string, unknown>)[key];
                if (item !== undefined) out[key] = canonicalize(item);
                return out;
            }, {});
    }
    return value;
}

export function hashPayload(payload: unknown): string {
    const raw =
        typeof payload === "string"
            ? payload
            : JSON.stringify(canonicalize(payload ?? {}));
    return createHash("sha256").update(raw).digest("hex");
}

export function newIdempotencyKey(): string {
    return `ai-act-${randomUUID()}`;
}

export function actionError(
    message: string,
    status: number,
    code: string
): Error & { status: number; code: string } {
    return Object.assign(new Error(message), { status, code });
}

export function assertActionActor(actor: AiActionActor): void {
    if (!actor?.userId || !actor?.role) {
        throw actionError("Unauthorized", 401, "UNAUTHORIZED");
    }
}

export async function assertActionTargetAccess(
    actor: AiActionActor,
    targetType: AiActionTargetType,
    targetId: string | null | undefined
): Promise<void> {
    assertActionActor(actor);
    if (!targetType || targetType === "none") return;
    if (!targetId) {
        throw actionError("targetId is required for this action", 422, "INVALID_TARGET");
    }

    if (targetType === "carrier") {
        try {
            await carrierService.assertCarrierAccess(targetId, {
                userId: actor.userId,
                role: actor.role,
            });
        } catch (err) {
            if ((err as { status?: number })?.status === 403) {
                throw actionError("Access denied", 403, "ACTION_FORBIDDEN");
            }
            throw err;
        }
        return;
    }

    if (targetType === "shipment") {
        try {
            await assertShipmentAccessOrThrow(
                { userId: actor.userId, role: actor.role },
                targetId
            );
        } catch (err) {
            if ((err as { status?: number })?.status === 403) {
                throw actionError("Access denied", 403, "ACTION_FORBIDDEN");
            }
            throw err;
        }
        return;
    }

    if (targetType === "document_job") {
        const job = await prisma.aiDocumentJob.findUnique({
            where: { jobId: targetId },
            select: {
                jobId: true,
                carrierId: true,
                shipmentLeadId: true,
                actorUserId: true,
            },
        });
        if (!job) throw actionError("Document job not found", 404, "NOT_FOUND");
        if (job.carrierId) {
            try {
                await carrierService.assertCarrierAccess(job.carrierId, {
                    userId: actor.userId,
                    role: actor.role,
                });
            } catch (err) {
                if ((err as { status?: number })?.status === 403) {
                    throw actionError("Access denied", 403, "ACTION_FORBIDDEN");
                }
                throw err;
            }
            return;
        }
        if (job.shipmentLeadId) {
            try {
                await assertShipmentAccessOrThrow(
                    { userId: actor.userId, role: actor.role },
                    job.shipmentLeadId
                );
            } catch (err) {
                if ((err as { status?: number })?.status === 403) {
                    throw actionError("Access denied", 403, "ACTION_FORBIDDEN");
                }
                throw err;
            }
            return;
        }
        if (
            job.actorUserId !== actor.userId &&
            !["Administrator", "Owner", "Manager"].includes(actor.role)
        ) {
            throw actionError("Access denied for document job", 403, "ACTION_FORBIDDEN");
        }
        return;
    }

    throw actionError(`Unsupported target type: ${targetType}`, 422, "INVALID_TARGET");
}

export async function writeAiActionAudit(input: {
    userId: string;
    action: string;
    entityId: string;
    oldValue?: string | null;
    newValue?: string | null;
}): Promise<void> {
    try {
        await prisma.auditLog.create({
            data: {
                userId: input.userId,
                module: "AI_ACTIONS",
                action: input.action,
                entityName: "AiAction",
                entityId: input.entityId,
                oldValue: input.oldValue ?? null,
                newValue: input.newValue ?? null,
            },
        });
    } catch {
        // never block
    }
}
