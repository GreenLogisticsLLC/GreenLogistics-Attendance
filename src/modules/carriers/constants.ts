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

export const DEFAULT_AGREEMENT_BODY = `CARRIER–BROKER AGREEMENT

This Carrier–Broker Agreement ("Agreement") is entered into between Green Logistics LLC ("Broker") and the undersigned motor carrier ("Carrier").

1. AUTHORITY. Carrier represents that it is duly authorized by the FMCSA with active MC and DOT authority, and maintains insurance as required by applicable law.

2. SERVICES. Carrier agrees to transport freight safely and on time pursuant to rate confirmations issued by Broker.

3. PAYMENT. Broker will pay Carrier the agreed rate stated on the applicable Rate Confirmation, subject to receipt of required paperwork (POD, invoice, and supporting documents).

4. COMPLIANCE. Carrier shall comply with all federal, state, and local laws, including Hours of Service and hazardous materials rules where applicable.

5. INDEMNITY. Carrier shall indemnify Broker against claims arising from Carrier's operations, negligence, or failure to perform.

6. INDEPENDENT CONTRACTOR. Carrier is an independent contractor and not an employee of Broker.

7. DOCUMENTS. Carrier agrees to provide current MC Authority, Notice of Assignment (NOA) if factoring, W-9, and insurance certificates as requested.

8. ELECTRONIC ACCEPTANCE. By typing or drawing a signature and checking acceptance in the Green OS Carrier Onboarding Portal, Carrier acknowledges review of this Agreement. This record creates an audit trail; parties may later adopt a formal e-signature provider.

Green Logistics LLC
Carrier Onboarding — Version 1.0
`;
