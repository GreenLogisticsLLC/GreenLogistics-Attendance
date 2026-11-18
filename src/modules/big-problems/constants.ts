export const BP_CATEGORIES = [
    "CARGO_DAMAGE",
    "SHORTAGE",
    "THEFT",
    "ACCIDENT",
    "CLAIM_DISPUTE",
    "PAYMENT_ISSUE",
    "COMPLIANCE",
    "OTHER",
] as const;

export type BpCategory = (typeof BP_CATEGORIES)[number];

export const BP_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type BpSeverity = (typeof BP_SEVERITIES)[number];

export const BP_CASE_STATUSES = [
    "OPEN",
    "IN_PROGRESS",
    "PENDING_REVIEW",
    "RESOLVED",
    "CLOSED",
    "REOPENED",
] as const;
export type BpCaseStatus = (typeof BP_CASE_STATUSES)[number];

export const BP_OPEN_STATUSES: BpCaseStatus[] = [
    "OPEN",
    "IN_PROGRESS",
    "PENDING_REVIEW",
    "RESOLVED",
    "REOPENED",
];

export const BP_TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type BpTaskPriority = (typeof BP_TASK_PRIORITIES)[number];

export const BP_TASK_STATUSES = ["OPEN", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export type BpTaskStatus = (typeof BP_TASK_STATUSES)[number];

export const BP_INSURANCE_STATUSES = ["PENDING", "APPROVED", "PAID", "DENIED"] as const;
export type BpInsuranceStatus = (typeof BP_INSURANCE_STATUSES)[number];

export const BP_DOC_KINDS = [
    "GENERAL",
    "FINANCIAL",
    "EVIDENCE",
    "COMMUNICATION",
    "OTHER",
] as const;

export const BP_COMM_CHANNELS = ["NOTE", "EMAIL", "CALL", "MEETING", "OTHER"] as const;

export const BP_TIMELINE_TYPES = [
    "CASE_CREATED",
    "CASE_UPDATED",
    "STATUS_CHANGED",
    "TASK_CREATED",
    "TASK_ASSIGNED",
    "TASK_UPDATED",
    "DEADLINE_CHANGED",
    "TASK_COMPLETED",
    "TASK_CANCELLED",
    "COMMENT_ADDED",
    "DOCUMENT_UPLOADED",
    "COMMUNICATION_ADDED",
    "FINANCIAL_CHANGED",
    "RESOLVED",
    "CLOSED",
    "REOPENED",
] as const;

export const CATEGORY_LABELS: Record<string, string> = {
    CARGO_DAMAGE: "Cargo damage",
    SHORTAGE: "Shortage",
    THEFT: "Theft",
    ACCIDENT: "Accident",
    CLAIM_DISPUTE: "Claim dispute",
    PAYMENT_ISSUE: "Payment issue",
    COMPLIANCE: "Compliance",
    OTHER: "Other",
};
