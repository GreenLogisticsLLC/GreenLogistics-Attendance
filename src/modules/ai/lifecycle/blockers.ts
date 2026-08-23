import type { LifecycleEvidence, LifecycleIssue, LifecycleStage } from "./types.js";

const BAD_DOCUMENT_STATUSES = new Set(["MISSING", "INVALID", "EXPIRED", "REVIEW_REQUIRED"]);

export function deriveLifecycleIssues(
    evidence: LifecycleEvidence,
    currentStage: LifecycleStage
): { blockers: LifecycleIssue[]; warnings: LifecycleIssue[] } {
    const blockers: LifecycleIssue[] = [];
    const warnings: LifecycleIssue[] = [];
    const addBlocker = (issue: LifecycleIssue) => blockers.push(issue);
    const addWarning = (issue: LifecycleIssue) => warnings.push(issue);

    const complianceReadiness = String(evidence.carrierCompliance?.readiness || "").toUpperCase();
    const complianceLight = String(evidence.carrierCompliance?.light || "").toUpperCase();
    if (complianceReadiness === "NOT_READY" || complianceLight === "RED") {
        addBlocker({
            code: "CARRIER_COMPLIANCE_BLOCKED",
            message: "Carrier compliance is not ready.",
            critical: true,
            source: "carrier_compliance",
        });
    } else if (complianceReadiness === "REVIEW_REQUIRED" || complianceLight === "REVIEW") {
        addWarning({
            code: "CARRIER_COMPLIANCE_REVIEW",
            message: "Carrier compliance requires human review.",
            critical: false,
            source: "carrier_compliance",
        });
    }

    for (const doc of evidence.documents || []) {
        if (!BAD_DOCUMENT_STATUSES.has(doc.status)) continue;
        const isPod = doc.slot === "POD";
        const signatureReview =
            isPod &&
            /UNSIGNED|TYPED_ONLY|MISSING|UNCERTAIN/i.test(
                `${doc.signatureStatus || ""} ${doc.validationStatus || ""} ${doc.reason || ""}`
            );
        const closingStage = ["DELIVERY", "POD_PENDING", "POD_REVIEW", "CLOSEOUT", "CLOSED"].includes(
            currentStage
        );
        const critical = doc.status === "INVALID" || doc.status === "EXPIRED" || signatureReview;
        const issue = {
            code: `${doc.slot}_${signatureReview ? "SIGNATURE_REVIEW" : doc.status}`,
            message: doc.reason || `${doc.slot} is ${doc.status.toLowerCase().replace(/_/g, " ")}.`,
            critical,
            source: doc.documentId || "shipment_documents",
            documentSlot: doc.slot,
        };
        if (critical || (isPod && closingStage)) addBlocker(issue);
        else addWarning(issue);
    }

    if (evidence.closeoutReadiness === "NOT_READY") {
        addBlocker({
            code: "CLOSEOUT_NOT_READY",
            message: "Operational closeout readiness is NOT_READY.",
            critical: true,
            source: "operational_summary",
        });
    } else if (evidence.closeoutReadiness === "REVIEW_REQUIRED") {
        addWarning({
            code: "CLOSEOUT_REVIEW_REQUIRED",
            message: "Operational closeout requires human review.",
            critical: false,
            source: "operational_summary",
        });
    }

    const waitingFor = evidence.communication?.waitingFor;
    if (waitingFor && !["NO_OUTSTANDING_WAIT", "INCOMPLETE"].includes(waitingFor)) {
        const customer = waitingFor === "WAITING_FOR_CUSTOMER";
        addWarning({
            code: waitingFor,
            message: `Shipment is ${waitingFor.toLowerCase().replace(/_/g, " ")}.`,
            critical: false,
            source: customer ? "customer_communication" : "communication",
        });
    }

    if (evidence.marketAssessment === "ABOVE_HISTORICAL_P75") {
        addWarning({
            code: "MARKET_ABOVE_P75",
            message: "Current carrier quote is above GreenOS historical P75.",
            critical: false,
            source: "internal_market_history",
        });
    } else if (evidence.marketAssessment === "BELOW_HISTORICAL_P25") {
        addWarning({
            code: "MARKET_BELOW_P25",
            message: "Current carrier quote is below GreenOS historical P25.",
            critical: false,
            source: "internal_market_history",
        });
    }

    if (evidence.tracking?.driverIsLate) {
        addWarning({
            code: "TRACKING_DRIVER_LATE",
            message: "Tracking reports that the driver is late.",
            critical: false,
            source: evidence.tracking.trackingId || "tracking",
        });
    }
    if (
        ["PICKUP", "IN_TRANSIT", "DELIVERY"].includes(currentStage) &&
        (!evidence.tracking || !evidence.tracking.complete)
    ) {
        addWarning({
            code: "TRACKING_INCOMPLETE",
            message: "Active tracking position, distance, or time-left data is incomplete.",
            critical: false,
            source: "tracking",
        });
    }

    return {
        blockers: uniqueIssues(blockers),
        warnings: uniqueIssues(warnings).filter(
            (warning) => !blockers.some((blocker) => blocker.code === warning.code)
        ),
    };
}

function uniqueIssues(issues: LifecycleIssue[]): LifecycleIssue[] {
    return [...new Map(issues.map((issue) => [issue.code, issue])).values()];
}
