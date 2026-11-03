import { buildBrokerCarrierAgreement } from "./agreement-template-v2.js";

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
    CARRIER_PROFILE: "CARRIER_PROFILE",
    MC_AUTHORITY: "MC_AUTHORITY",
    NOA: "NOA",
    LOR: "LOR",
    W9: "W9",
    INSURANCE: "INSURANCE",
    COI: "COI",
    BROKER_CARRIER_AGREEMENT: "BROKER_CARRIER_AGREEMENT",
    RATE_CONFIRMATION: "RATE_CONFIRMATION",
    BOL: "BOL",
    POD: "POD",
    OTHER: "OTHER",
} as const;

/** Marked required on the carrier portal Documents step (red indicators). */
export const REQUIRED_CARRIER_DOC_TYPES = [
    CARRIER_DOC_TYPES.MC_AUTHORITY,
    CARRIER_DOC_TYPES.W9,
    CARRIER_DOC_TYPES.INSURANCE,
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

/** Extensions we accept even when the browser sends a generic MIME (octet-stream). */
export const ALLOWED_UPLOAD_EXT = new Set([
    ".pdf",
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".doc",
    ".docx",
]);

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export const DEFAULT_ONBOARDING_EXPIRY_DAYS = 7;

export const ONBOARDING_PURPOSE = {
    AGREEMENT_PACKET: "AGREEMENT_PACKET",
    /** @deprecated Prefer RC_SIGN_PACKET / BOL_POD_PACKET */
    RC_BOL_PACKET: "RC_BOL_PACKET",
    /** After Generate Rate Con — carrier signs RC only */
    RC_SIGN_PACKET: "RC_SIGN_PACKET",
    /** After Generate BOL — BOL / POD link without Rate Confirmation */
    BOL_POD_PACKET: "BOL_POD_PACKET",
} as const;

export type OnboardingPurpose = (typeof ONBOARDING_PURPOSE)[keyof typeof ONBOARDING_PURPOSE];

export const AGREEMENT_TEMPLATE_VERSION = "2.6";
export const AGREEMENT_TEMPLATE_TITLE = "Broker - Carrier Agreement";

/** Single source for the broker block on the Setup agreement and the signed PDF. */
export const BROKER_AGREEMENT_CONTACT = {
    legalName: "GREEN LOGISTICS LLC",
    signerName: "SPARTAK KAZARYAN",
    title: "PRESIDENT",
    address: "121 Frog Hollow Rd, Churchville, PA 18966",
    phone: "(267) 703-5313",
    email: "accounting@greengrouplogistics.com",
    mcNumber: "1237784",
    usdotNumber: "3622287",
} as const;

export const DEFAULT_AGREEMENT_BODY = buildBrokerCarrierAgreement(BROKER_AGREEMENT_CONTACT);

/** Human-readable label for carrier portal payment option codes. */
export function carrierPaymentOptionLabel(code: string | null | undefined): string {
    switch (String(code || "").toUpperCase()) {
        case "STANDARD":
            return "Standard Payment (10-15 days)";
        case "QUICK_3":
            return "Quick Pay 3% (3-5 business days, ACH)";
        case "QUICK_5":
            return "Quick Pay 5% (24hrs)";
        case "FACTORING":
            return "Factoring company";
        default:
            return code ? String(code) : "";
    }
}
