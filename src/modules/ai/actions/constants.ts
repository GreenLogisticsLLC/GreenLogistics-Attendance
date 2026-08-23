/**
 * Phase 6 — AI Actions constants (never LLM-controlled).
 */

export const AI_ACTION_TYPES = [
    "SEND_EMAIL",
    "CREATE_INTERNAL_NOTE",
    "CREATE_FOLLOW_UP",
    "REQUEST_DOCUMENT",
    "MARK_REVIEW_REQUIRED",
] as const;

export type AiActionType = (typeof AI_ACTION_TYPES)[number];

export const BLOCKED_ACTION_TYPES = [
    "APPROVE_CARRIER",
    "REJECT_CARRIER",
    "CLOSE_SHIPMENT",
    "CHANGE_RATE",
    "DELETE_DOCUMENT",
    "PAY_CARRIER",
    "BOOK_LOAD",
    "NEGOTIATE_RATE",
] as const;

export const AI_ACTION_STATUSES = [
    "DRAFT",
    "PENDING_CONFIRMATION",
    "CONFIRMED",
    "EXECUTING",
    "EXECUTED",
    "FAILED",
    "CANCELLED",
    "EXPIRED",
    "ALREADY_EXECUTED",
] as const;

export type AiActionStatus = (typeof AI_ACTION_STATUSES)[number];

export const AI_ACTION_TARGET_TYPES = [
    "carrier",
    "shipment",
    "document_job",
    "none",
] as const;

export type AiActionTargetType = (typeof AI_ACTION_TARGET_TYPES)[number];

export const AI_ACTION_TTL_MINUTES = 60;

export const SENSITIVE_EMAIL_DOC_TYPES = [
    "W9",
    "W-9",
    "TIN",
    "SSN",
    "TAX",
    "BANK",
    "VOID_CHECK",
] as const;

export function isSensitiveDocType(docType: string | null | undefined): boolean {
    const u = String(docType || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
    return SENSITIVE_EMAIL_DOC_TYPES.some((s) =>
        u.includes(s.replace(/[^A-Z0-9]/g, ""))
    );
}

export function isAllowedActionType(t: string): t is AiActionType {
    return (AI_ACTION_TYPES as readonly string[]).includes(t);
}

export function isBlockedActionType(t: string): boolean {
    return (BLOCKED_ACTION_TYPES as readonly string[]).includes(t);
}
