export const CARRIER_ONBOARDING_STATUSES = [
    "INVITED",
    "OPENED",
    "IN_PROGRESS",
    "SUBMITTED",
    "UNDER_REVIEW",
    "APPROVED",
    "REJECTED",
    "EXPIRED",
    "REQUEST_CHANGES",
] as const;

export type CarrierOnboardingStatus = (typeof CARRIER_ONBOARDING_STATUSES)[number];

export const CARRIER_DOC_TYPES = {
    MC_AUTHORITY: "MC_AUTHORITY",
    NOA: "NOA",
    W9: "W9",
    INSURANCE: "INSURANCE",
    COI: "COI",
    BROKER_CARRIER_AGREEMENT: "BROKER_CARRIER_AGREEMENT",
    RATE_CONFIRMATION: "RATE_CONFIRMATION",
    OTHER: "OTHER",
} as const;

export const REQUIRED_CARRIER_DOC_TYPES = [
    CARRIER_DOC_TYPES.MC_AUTHORITY,
    CARRIER_DOC_TYPES.NOA,
    CARRIER_DOC_TYPES.W9,
] as const;

export const ALLOWED_UPLOAD_MIME = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export const DEFAULT_ONBOARDING_EXPIRY_DAYS = 7;

export const ONBOARDING_PURPOSE = {
    AGREEMENT_PACKET: "AGREEMENT_PACKET",
    RC_BOL_PACKET: "RC_BOL_PACKET",
} as const;

export type OnboardingPurpose = (typeof ONBOARDING_PURPOSE)[keyof typeof ONBOARDING_PURPOSE];

export { GREEN_LOGISTICS_AGREEMENT_V2 as DEFAULT_AGREEMENT_BODY } from "./agreement-template-v2.js";
export const AGREEMENT_TEMPLATE_VERSION = "2.0";
export const AGREEMENT_TEMPLATE_TITLE = "Broker - Carrier Agreement";
