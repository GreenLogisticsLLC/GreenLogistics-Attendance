import type {
    LifecycleEvidence,
    LifecycleIssue,
    LifecycleNextBestAction,
    LifecycleStage,
} from "./types.js";

export function deriveNextBestAction(input: {
    stage: LifecycleStage;
    evidence: LifecycleEvidence;
    blockers: LifecycleIssue[];
    warnings: LifecycleIssue[];
}): LifecycleNextBestAction {
    if (input.blockers.some((issue) => issue.code === "CARRIER_COMPLIANCE_BLOCKED")) {
        return "REVIEW_COMPLIANCE";
    }
    const podIssue = [...input.blockers, ...input.warnings].find(
        (issue) => issue.documentSlot === "POD"
    );
    if (podIssue) {
        return podIssue.code.includes("MISSING") ? "REQUEST_DOCUMENT" : "REVIEW_POD";
    }
    const documentIssue = [...input.blockers, ...input.warnings].find(
        (issue) => issue.documentSlot && issue.documentSlot !== "POD"
    );
    if (documentIssue) {
        return documentIssue.code.includes("MISSING") ? "REQUEST_DOCUMENT" : "REVIEW_DOCUMENT";
    }
    if (input.evidence.communication?.waitingFor === "WAITING_FOR_CUSTOMER") {
        return "FOLLOW_UP_CUSTOMER";
    }
    if (
        ["WAITING_FOR_CARRIER", "WAITING_FOR_RESPONSE", "WAITING_FOR_SIGNATURE"].includes(
            input.evidence.communication?.waitingFor || ""
        )
    ) {
        return "FOLLOW_UP_CARRIER";
    }
    if (
        ["ABOVE_HISTORICAL_P75", "BELOW_HISTORICAL_P25"].includes(
            input.evidence.marketAssessment || ""
        )
    ) {
        return "REVIEW_RATE";
    }
    if (
        ["PICKUP", "IN_TRANSIT", "DELIVERY"].includes(input.stage) &&
        (!input.evidence.tracking || !input.evidence.tracking.complete)
    ) {
        return "CHECK_TRACKING";
    }
    if (input.evidence.closeoutReadiness === "READY_TO_CLOSE" && input.stage !== "CLOSED") {
        return "CLOSE_SHIPMENT_MANUALLY";
    }
    return "NO_ACTION";
}
