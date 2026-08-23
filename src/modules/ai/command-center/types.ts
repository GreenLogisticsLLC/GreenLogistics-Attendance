import type { AiActionPublicView } from "../actions/types.js";

export type AiOperationalCategory =
    | "SHIPMENT"
    | "CARRIER"
    | "DOCUMENT"
    | "COMMUNICATION"
    | "MARKET"
    | "COMPLIANCE"
    | "FOLLOW_UP"
    | "INTERNAL_REVIEW";

export type AiOperationalPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type NextBestAction =
    | "REQUEST_DOCUMENT"
    | "FOLLOW_UP"
    | "REVIEW_DOCUMENT"
    | "REVIEW_COMPLIANCE"
    | "CONTACT_CUSTOMER"
    | "REVIEW_MARKET_RATE"
    | "REVIEW_SHIPMENT"
    | "SEND_EMAIL"
    | "NO_ACTION";

export type ActionDisplayState =
    | "NO_ACTION"
    | "RECOMMENDATION"
    | "PENDING_CONFIRMATION"
    | "EXECUTED"
    | "FAILED"
    | "CANCELLED"
    | "EXPIRED";

export type AiOperationalSource = {
    type: string;
    id: string;
    label: string;
};

export type AiOperationalItem = {
    id: string;
    category: AiOperationalCategory;
    priority: AiOperationalPriority;
    severity?: string;
    title: string;
    summary: string;
    entityType: "shipment" | "carrier" | "document" | "communication" | "market";
    entityId: string;
    entityLabel?: string;
    status: string;
    reason: string;
    nextBestAction: NextBestAction;
    action?: AiActionPublicView | null;
    sources: AiOperationalSource[];
    createdAt?: string;
    updatedAt?: string;
    blocking?: boolean;
    dedupeKey: string;
};

export type CommandCenterResult = {
    items: AiOperationalItem[];
    counts: Record<AiOperationalPriority, number>;
    categoryCounts?: Partial<Record<AiOperationalCategory, number>>;
    generatedAt: string;
    sources?: AiOperationalSource[];
    incomplete?: string[];
    summaryHints?: {
        total: number;
        requiringAction: number;
        blocking: number;
        topPriority: AiOperationalPriority | null;
    };
    marketProviders: {
        internal: "AVAILABLE";
        dat: "NOT_CONNECTED";
        truckstop: "NOT_CONNECTED";
    };
    message?: string;
    actionsRequireConfirmation?: true;
};

export type CommandCenterQuery = {
    priority?: AiOperationalPriority;
    category?: AiOperationalCategory;
    entityType?: string;
    entityId?: string;
    limit?: number;
    offset?: number;
    myWork?: boolean;
};

export type CommandCenterActor = { userId: string; role: string };
