import { normalizeStatus } from "../../shipment/shipment.lifecycle.js";
import type {
    LifecycleEvidence,
    LifecycleHistoryEntry,
    LifecycleStage,
    LifecycleStageEntry,
    StageProgress,
} from "./types.js";

export const LIFECYCLE_STAGE_ORDER: LifecycleStage[] = [
    "NEW",
    "ASSIGNED",
    "CUSTOMER_CONFIRMED",
    "CARRIER_SELECTED",
    "CARRIER_COMPLIANCE",
    "RATE_CONFIRMED",
    "RC_CONFIRMED",
    "READY_FOR_PICKUP",
    "PICKUP",
    "IN_TRANSIT",
    "DELIVERY",
    "POD_PENDING",
    "POD_REVIEW",
    "CLOSEOUT",
    "CLOSED",
];

function document(evidence: LifecycleEvidence, slot: string) {
    return evidence.documents?.find((item) => item.slot === slot);
}

function isValid(item: ReturnType<typeof document>): boolean {
    return item?.status === "VALID";
}

function complianceBlocked(evidence: LifecycleEvidence): boolean {
    const readiness = String(evidence.carrierCompliance?.readiness || "").toUpperCase();
    const light = String(evidence.carrierCompliance?.light || "").toUpperCase();
    return readiness === "NOT_READY" || light === "RED";
}

export function deriveCurrentStage(evidence: LifecycleEvidence): LifecycleStage {
    const status = normalizeStatus(evidence.status);
    const pod = document(evidence, "POD");
    const rc = document(evidence, "RATE_CONFIRMATION");

    if (["LOST", "DELETED_FROM_CUSTOMER"].includes(status)) return "CLOSED";
    if (status === "CLOSED") return "CLOSED";
    if (complianceBlocked(evidence) && LIFECYCLE_STAGE_ORDER.indexOf(statusStage(status)) >= 3) {
        return "CARRIER_COMPLIANCE";
    }
    if (["CUSTOMER_INVOICE", "CARRIER_PAYMENT", "COMPLETED"].includes(status)) return "CLOSEOUT";
    if (status === "POD_UPLOADED") {
        return isValid(pod) ? "CLOSEOUT" : "POD_REVIEW";
    }
    if (status === "DELIVERED") {
        return isValid(pod) ? "POD_REVIEW" : "POD_PENDING";
    }
    if (["IN_TRANSIT", "DISPATCH"].includes(status)) return "IN_TRANSIT";
    if (status === "PICKUP") return "PICKUP";
    if (status === "CARRIER_ACCEPTED") {
        return isValid(rc) || rc?.status === "PRESENT" ? "READY_FOR_PICKUP" : "RC_CONFIRMED";
    }
    if (status === "RATE_CON_GENERATED" || evidence.ratePresent) {
        return rc && rc.status !== "MISSING" ? "RC_CONFIRMED" : "RATE_CONFIRMED";
    }
    return statusStage(status);
}

function statusStage(status: string): LifecycleStage {
    switch (normalizeStatus(status)) {
        case "NEW":
        case "UNASSIGNED":
            return "NEW";
        case "ASSIGNED":
        case "AWAITING_ACCEPTANCE":
        case "AGENT_OPEN":
        case "WORKING":
        case "FOLLOW_UP":
        case "BID_SUBMITTED":
        case "CUSTOMER_REPLIED":
            return "ASSIGNED";
        case "ACCEPTED":
        case "LOAD_CREATED":
            return "CUSTOMER_CONFIRMED";
        case "CARRIER_ASSIGNED":
            return "CARRIER_SELECTED";
        case "RATE_CON_GENERATED":
            return "RATE_CONFIRMED";
        case "CARRIER_ACCEPTED":
            return "RC_CONFIRMED";
        case "PICKUP":
            return "PICKUP";
        case "IN_TRANSIT":
        case "DISPATCH":
            return "IN_TRANSIT";
        case "DELIVERED":
            return "DELIVERY";
        case "POD_UPLOADED":
            return "POD_REVIEW";
        case "CUSTOMER_INVOICE":
        case "CARRIER_PAYMENT":
        case "COMPLETED":
            return "CLOSEOUT";
        case "CLOSED":
        case "LOST":
        case "DELETED_FROM_CUSTOMER":
            return "CLOSED";
        default:
            return "INCOMPLETE";
    }
}

export function stageProgress(
    stage: LifecycleStage,
    current: LifecycleStage,
    evidence: LifecycleEvidence
): StageProgress {
    if (stage === "CARRIER_COMPLIANCE" && complianceBlocked(evidence)) return "BLOCKED";
    if (stage === "POD_REVIEW") {
        const pod = document(evidence, "POD");
        if (pod && ["REVIEW_REQUIRED", "INVALID", "EXPIRED"].includes(pod.status)) return "BLOCKED";
    }
    const currentIndex = LIFECYCLE_STAGE_ORDER.indexOf(current);
    const index = LIFECYCLE_STAGE_ORDER.indexOf(stage);
    if (current === "INCOMPLETE" || currentIndex < 0 || index < 0) return "INCOMPLETE";
    if (index < currentIndex) return "COMPLETE";
    if (index === currentIndex) return current === "CLOSED" ? "COMPLETE" : "IN_PROGRESS";
    return index === currentIndex + 1 ? "PENDING" : "NOT_STARTED";
}

export function buildStageChecklist(evidence: LifecycleEvidence): LifecycleStageEntry[] {
    const current = deriveCurrentStage(evidence);
    return LIFECYCLE_STAGE_ORDER.map((stage) => ({
        stage,
        progress: stageProgress(stage, current, evidence),
    }));
}

export function stageFromEventType(type: string): LifecycleStage {
    return statusStage(
        String(type || "")
            .replace(/_MARKED$/, "")
            .replace("SHIPMENT_IMPORTED", "NEW")
            .replace("BROKER_ASSIGNED", "ASSIGNED")
            .replace("CUSTOMER_ACCEPTED", "ACCEPTED")
            .replace("RATE_CONFIRMATION_GENERATED", "RATE_CON_GENERATED")
            .replace("SHIPMENT_COMPLETED", "COMPLETED")
            .replace("SHIPMENT_CLOSED", "CLOSED")
    );
}

export function buildStageHistory(
    events: Array<{ at: string; title: string; type: string; id: string }>
): LifecycleHistoryEntry[] {
    return events
        .map((event) => ({ ...event, stage: stageFromEventType(event.type) }))
        .filter((event) => event.stage !== "INCOMPLETE")
        .sort((a, b) => a.at.localeCompare(b.at));
}

export const _stageTestUtils = { statusStage, complianceBlocked, document };
