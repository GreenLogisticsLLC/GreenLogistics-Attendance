import type {
    DocumentChecklistItem,
    OperationalSource,
    ShipmentReadiness,
} from "../operational/types.js";
import type { CommunicationContext } from "../communications/types.js";

export type LifecycleStage =
    | "NEW"
    | "ASSIGNED"
    | "CUSTOMER_CONFIRMED"
    | "CARRIER_SELECTED"
    | "CARRIER_COMPLIANCE"
    | "RATE_CONFIRMED"
    | "RC_CONFIRMED"
    | "READY_FOR_PICKUP"
    | "PICKUP"
    | "IN_TRANSIT"
    | "DELIVERY"
    | "POD_PENDING"
    | "POD_REVIEW"
    | "CLOSEOUT"
    | "CLOSED"
    | "BLOCKED"
    | "INCOMPLETE";

export type StageProgress =
    | "COMPLETE"
    | "IN_PROGRESS"
    | "PENDING"
    | "BLOCKED"
    | "NOT_STARTED"
    | "INCOMPLETE";

export type LifecycleHealth = "HEALTHY" | "ATTENTION_REQUIRED" | "BLOCKED" | "INCOMPLETE";
export type CloseoutReadiness = ShipmentReadiness;

export type LifecycleIssue = {
    code: string;
    message: string;
    critical: boolean;
    source?: string;
    documentSlot?: string;
};

export type LifecycleNextBestAction =
    | "REQUEST_DOCUMENT"
    | "REVIEW_DOCUMENT"
    | "FOLLOW_UP_CARRIER"
    | "FOLLOW_UP_CUSTOMER"
    | "REVIEW_COMPLIANCE"
    | "REVIEW_RATE"
    | "CHECK_TRACKING"
    | "REVIEW_POD"
    | "CLOSE_SHIPMENT_MANUALLY"
    | "NO_ACTION";

export type LifecycleStageEntry = {
    stage: LifecycleStage;
    progress: StageProgress;
    reason?: string;
};

export type LifecycleHistoryEntry = {
    stage: LifecycleStage;
    at: string;
    title: string;
    type: string;
    id: string;
};

export type LifecycleTracking = {
    trackingId?: string;
    status?: string;
    provider?: string;
    lastAddress?: string | null;
    lastPositionAt?: string | null;
    timeLeftSec?: number | null;
    distanceLeftMeters?: number | null;
    driverIsLate?: boolean;
    complete: boolean;
} | null;

export type ShipmentLifecycleContext = {
    shipmentId: string;
    loadNumber?: string | null;
    currentStage: LifecycleStage;
    stageStatus: StageProgress;
    progress: StageProgress;
    lifecycleHealth: LifecycleHealth;
    closeoutReadiness: CloseoutReadiness;
    stageHistory: LifecycleHistoryEntry[];
    stages: LifecycleStageEntry[];
    blockers: LifecycleIssue[];
    warnings: LifecycleIssue[];
    missingItems: string[];
    completedItems: string[];
    pendingItems: string[];
    carrier: Record<string, unknown> | null;
    customer: Record<string, unknown>;
    rate: Record<string, unknown>;
    documents: DocumentChecklistItem[];
    communication: Pick<
        CommunicationContext,
        | "communicationStatus"
        | "waitingFor"
        | "waitingSince"
        | "followUp"
        | "recommendations"
        | "lastContact"
    > | null;
    tracking: LifecycleTracking;
    timeline: Array<{ at: string; title: string; type: string; id: string }>;
    nextBestAction: LifecycleNextBestAction;
    sources: OperationalSource[];
    incompleteSubsystems: string[];
    generatedAt: string;
    groundingLabel: "Based on GreenOS lifecycle data";
};

export type LifecycleEvidence = {
    status: string;
    documents?: DocumentChecklistItem[];
    carrierCompliance?: { readiness?: string | null; light?: string | null };
    ratePresent?: boolean;
    communication?: Pick<CommunicationContext, "waitingFor" | "followUp"> | null;
    tracking?: LifecycleTracking;
    closeoutReadiness?: CloseoutReadiness;
    marketAssessment?: string | null;
    incompleteSubsystems?: string[];
};
