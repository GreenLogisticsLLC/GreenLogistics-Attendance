/**
 * Phase 4 — Operational AI types (computed, read-only).
 */

export type ComplianceLight = "GREEN" | "REVIEW" | "RED";

export type CarrierReadiness = "READY" | "REVIEW_REQUIRED" | "NOT_READY";

export type ShipmentReadiness =
    | "READY_TO_CLOSE"
    | "REVIEW_REQUIRED"
    | "NOT_READY"
    | "INCOMPLETE";

export type DocSlotStatus =
    | "MISSING"
    | "PRESENT"
    | "VALID"
    | "EXPIRED"
    | "INVALID"
    | "REVIEW_REQUIRED"
    | "NOT_APPLICABLE";

export type OperationalPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type OperationalRecommendation = {
    id: string;
    label: "RECOMMENDATION";
    text: string;
    reason: string;
    priority: OperationalPriority;
    source?: string;
    humanConfirmationRequired: true;
};

export type DocumentChecklistItem = {
    documentType: string;
    slot: string;
    status: DocSlotStatus;
    validationStatus: string | null;
    trafficLight: string | null;
    expiration: string | null;
    signatureStatus: string | null;
    reason: string;
    documentId: string | null;
};

export type OperationalMismatch = {
    id: string;
    field: string;
    status: "MATCH" | "MISMATCH" | "CRITICAL_MISMATCH" | "MISSING";
    message: string;
    values: Record<string, string | null>;
};

export type OperationalSource = {
    type: string;
    id: string;
    label: string;
    carrierId?: string;
    shipmentLeadId?: string;
};

export type CarrierOperationalSummary = {
    carrier: Record<string, unknown>;
    readiness: CarrierReadiness;
    compliance: {
        light: ComplianceLight;
        summary: string;
    };
    documents: DocumentChecklistItem[];
    missingDocuments: string[];
    reviewItems: string[];
    mismatches: OperationalMismatch[];
    warnings: string[];
    recommendations: OperationalRecommendation[];
    nextBestActions: OperationalRecommendation[];
    sources: OperationalSource[];
    answerMode: "OPERATIONAL";
    groundingLabel: "Based on GreenOS data";
};

export type ShipmentOperationalSummary = {
    shipment: Record<string, unknown>;
    carrier: Record<string, unknown> | null;
    readiness: ShipmentReadiness;
    documents: DocumentChecklistItem[];
    timeline: Array<{ at: string; title: string; type: string; id: string }>;
    emails: Array<{ id: string; subject: string; from: string; at: string; snippet: string }>;
    tracking: Record<string, unknown> | null;
    missingDocuments: string[];
    reviewItems: string[];
    warnings: string[];
    recommendations: OperationalRecommendation[];
    nextBestActions: OperationalRecommendation[];
    sources: OperationalSource[];
    answerMode: "OPERATIONAL";
    groundingLabel: "Based on GreenOS data";
    incompleteContext: string[];
};
