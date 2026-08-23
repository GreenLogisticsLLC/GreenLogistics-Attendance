import type { AiActionStatus, AiActionTargetType, AiActionType } from "./constants.js";

export type AiActionActor = { userId: string; role: string };

export type AiActionSource = {
    type: string;
    id: string;
    label: string;
};

export type AiActionPayload = Record<string, unknown>;

export type ProposeAiActionInput = {
    actionType: AiActionType;
    title: string;
    description?: string;
    reason?: string;
    targetType: AiActionTargetType;
    targetId?: string;
    payload: AiActionPayload;
    sources?: AiActionSource[];
    aiRunId?: string;
    groundingHash?: string;
    ttlMinutes?: number;
};

export type AiActionPublicView = {
    actionId: string;
    actionType: AiActionType;
    status: AiActionStatus;
    title: string;
    description: string | null;
    reason: string | null;
    target: { type: AiActionTargetType; id: string | null };
    requiresConfirmation: true;
    payload: AiActionPayload;
    sources: AiActionSource[];
    expiresAt: string;
    createdAt: string;
    confirmedAt: string | null;
    executedAt: string | null;
    result: Record<string, unknown> | null;
    errorMessage: string | null;
    aiRunId: string | null;
};

export type AiActionView = AiActionPublicView;

export type ConfirmAiActionResult = {
    status: AiActionStatus;
    action: AiActionPublicView;
    execution?: Record<string, unknown>;
};
