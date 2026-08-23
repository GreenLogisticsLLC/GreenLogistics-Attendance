import { normalizeStatus } from "./shipment.lifecycle.js";

export type QuickActionState = "done" | "current" | "locked";

export type LoadQuickAction = {
    id: string;
    label: string;
    status?: string;
    docType?: string;
    kind?: "action" | "status";
    state: QuickActionState;
    blockedReason?: string;
};

export type LoadQuickActionInput = {
    status: string;
    carrierName?: string | null;
    /** Carrier.onboardingStatus — Rate Con stays locked until APPROVED. */
    carrierOnboardingStatus?: string | null;
    customerPaidAt?: Date | string | null;
    carrierPaidAt?: Date | string | null;
    reviewCustomerSentAt?: Date | string | null;
    reviewCarrierSentAt?: Date | string | null;
    documents: Array<{ docType?: string | null; contentJson?: string | null }>;
};

const FLOW = [
    "LOAD_CREATED",
    "CARRIER_ASSIGNED",
    "RATE_CON_GENERATED",
    "CARRIER_ACCEPTED",
    "PICKUP",
    "IN_TRANSIT",
    "DELIVERED",
    "POD_UPLOADED",
    "CUSTOMER_INVOICE",
    "CARRIER_PAYMENT",
    "CLOSED",
] as const;

function flowIndex(status: string): number {
    const n = normalizeStatus(status);
    const i = FLOW.indexOf(n as (typeof FLOW)[number]);
    return i >= 0 ? i : -1;
}

function hasType(docs: Set<string>, type: string): boolean {
    return docs.has(String(type || "").toUpperCase());
}

export function isCarrierApprovedForRateCon(onboardingStatus?: string | null): boolean {
    return String(onboardingStatus || "").toUpperCase() === "APPROVED";
}

/**
 * Sequential Quick Actions: the next incomplete step is current (green primary);
 * earlier steps stay done (green, still clickable to change data);
 * later steps stay locked until prior work is finished.
 */
export function buildLoadQuickActions(input: LoadQuickActionInput): LoadQuickAction[] {
    const statusIdx = flowIndex(input.status);
    const docs = new Set(
        (input.documents || [])
            .map((d) => String(d.docType || "").toUpperCase())
            .filter(Boolean)
    );

    const carrierDone =
        Boolean(String(input.carrierName || "").trim()) || statusIdx >= flowIndex("CARRIER_ASSIGNED");
    const carrierApproved = isCarrierApprovedForRateCon(input.carrierOnboardingStatus);
    const rateConDone = hasType(docs, "RATE_CONFIRMATION") || statusIdx >= flowIndex("RATE_CON_GENERATED");
    const bolDone = hasType(docs, "BOL") || statusIdx >= flowIndex("CARRIER_ACCEPTED");
    const pickupDone = statusIdx >= flowIndex("PICKUP");
    const transitDone = statusIdx >= flowIndex("IN_TRANSIT");
    const deliveredDone = statusIdx >= flowIndex("DELIVERED");

    /** POD is complete when a POD file exists with receiver SIGNATURE (or status already advanced). */
    const podRow = (input.documents || []).find(
        (d) => String(d.docType || "").toUpperCase() === "POD"
    );
    let podSigned = false;
    if (podRow) {
        podSigned = true;
        if (podRow.contentJson) {
            try {
                const c = JSON.parse(podRow.contentJson) as {
                    receiverSignatureDetected?: boolean;
                    analysis?: { hasReceiverSignature?: boolean };
                };
                if (
                    c.receiverSignatureDetected === false &&
                    c.analysis?.hasReceiverSignature === false
                ) {
                    podSigned = false;
                }
            } catch {
                /* keep podSigned */
            }
        }
    }
    const podDone = podSigned || statusIdx >= flowIndex("POD_UPLOADED");
    const closedDone = statusIdx >= flowIndex("CLOSED") || normalizeStatus(input.status) === "CLOSED";
    // Preserve legacy loads that already reached the old carrier-payment/closed stage.
    const legacyPaid = statusIdx >= flowIndex("CARRIER_PAYMENT");
    const customerPaid = Boolean(input.customerPaidAt) || legacyPaid || closedDone;
    const carrierPaid = Boolean(input.carrierPaidAt) || legacyPaid || closedDone;
    const reviewSent =
        Boolean(input.reviewCustomerSentAt) ||
        Boolean(input.reviewCarrierSentAt) ||
        closedDone;

    const rateConNeed = !carrierDone
        ? "Assign Carrier first"
        : !carrierApproved
          ? "Approve the carrier package first (signed agreement + documents)"
          : "Assign Carrier first";

    const defs: Array<{
        id: string;
        label: string;
        status?: string;
        docType?: string;
        kind?: "action" | "status";
        done: boolean;
        need: string;
    }> = [
        {
            id: "assign_carrier",
            label: "Assign Carrier",
            status: "CARRIER_ASSIGNED",
            done: carrierDone,
            need: "Create the Load first",
        },
        {
            id: "generate_rate_con",
            label: "Generate Rate Confirmation",
            docType: "RATE_CONFIRMATION",
            done: rateConDone,
            need: rateConNeed,
        },
        {
            id: "generate_bol",
            label: "Generate BOL",
            docType: "BOL",
            done: bolDone,
            need: "Generate Rate Confirmation first",
        },
        {
            id: "mark_pickup",
            label: "Mark Loaded / Pickup",
            status: "PICKUP",
            done: pickupDone,
            need: "Generate BOL first",
        },
        {
            id: "mark_transit",
            label: "Mark In Transit",
            status: "IN_TRANSIT",
            done: transitDone,
            need: "Mark Loaded / Pickup first",
        },
        {
            id: "mark_delivered",
            label: "Mark Delivered",
            status: "DELIVERED",
            done: deliveredDone,
            need: "Mark In Transit first",
        },
        {
            id: "upload_pod",
            label: "Upload POD",
            docType: "POD",
            done: podDone,
            need: "Mark Delivered first",
        },
        {
            id: "mark_customer_paid",
            label: "Customer Paid",
            kind: "status",
            done: customerPaid,
            need: "Accounting has not marked Payment Received",
        },
        {
            id: "mark_carrier_paid",
            label: "Carrier Paid",
            kind: "status",
            done: carrierPaid,
            need: "Accounting has not marked Carrier Paid",
        },
        {
            id: "send_review_link",
            label: "Send Review Link",
            done: reviewSent,
            need: "Upload POD with receiver SIGNATURE first",
        },
        {
            id: "close_load",
            label: "Close Load",
            status: "CLOSED",
            done: closedDone,
            need: !reviewSent
                ? "Send Review Link first"
                : "Customer Paid and Carrier Paid are required before closing",
        },
    ];

    const firstOpenAction = defs.findIndex((d) => {
        if (d.done || d.kind === "status") return false;
        // Rate Con is not eligible until the carrier package is approved.
        if (d.id === "generate_rate_con" && !carrierApproved) return false;
        return true;
    });
    const firstOpenPayment = defs.findIndex((d) => !d.done && d.kind === "status");

    return defs.map((d, i) => {
        let state: QuickActionState;
        let blockedReason: string | undefined;
        if (d.done) {
            state = "done";
        } else if (d.kind === "status") {
            if (i === firstOpenPayment) {
                state = "current";
            } else {
                state = "locked";
                blockedReason = d.need;
            }
        } else if (
            d.id === "close_load" &&
            (!reviewSent || !customerPaid || !carrierPaid)
        ) {
            state = "locked";
            blockedReason = d.need;
        } else if (d.id === "generate_rate_con" && !carrierApproved) {
            state = "locked";
            blockedReason = rateConNeed;
        } else if (i === firstOpenAction) {
            state = "current";
        } else {
            state = "locked";
            blockedReason = d.need;
        }
        return {
            id: d.id,
            label: d.label,
            status: d.status,
            docType: d.docType,
            kind: d.kind || "action",
            state,
            blockedReason,
        };
    });
}

/** Throw 422 when an action is not the allowed next step. */
export function assertQuickActionAllowed(actionId: string, input: LoadQuickActionInput) {
    const actions = buildLoadQuickActions(input);
    const row = actions.find((a) => a.id === actionId);
    if (!row) {
        throw Object.assign(new Error(`Unknown load action: ${actionId}`), { status: 422 });
    }
    if (row.state === "locked") {
        throw Object.assign(
            new Error(row.blockedReason || "Complete the previous step before continuing"),
            { status: 422, code: "STEP_LOCKED" }
        );
    }
    if (row.state === "done") {
        // Allow revisiting completed steps to change carrier / regenerate documents.
        if (row.docType) return;
        if (
            actionId === "send_review_link" ||
            actionId === "assign_carrier" ||
            actionId === "mark_pickup"
        ) {
            return;
        }
        throw Object.assign(new Error("This step is already completed"), {
            status: 422,
            code: "STEP_DONE",
        });
    }
}

/** Map document type → quick-action id for sequential checks on generate. */
export function quickActionIdForDocType(docType: string): string | null {
    const t = String(docType || "").toUpperCase();
    if (t === "RATE_CONFIRMATION") return "generate_rate_con";
    if (t === "BOL") return "generate_bol";
    if (t === "POD") return "upload_pod";
    return null;
}
