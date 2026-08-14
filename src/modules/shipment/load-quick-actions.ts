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

/**
 * Sequential Quick Actions: only the next incomplete step is current;
 * earlier steps are done; later steps stay locked until prior work is finished.
 */
export function buildLoadQuickActions(input: {
    status: string;
    carrierName?: string | null;
    customerPaidAt?: Date | string | null;
    carrierPaidAt?: Date | string | null;
    reviewCustomerSentAt?: Date | string | null;
    reviewCarrierSentAt?: Date | string | null;
    documents: Array<{ docType?: string | null; contentJson?: string | null }>;
}): LoadQuickAction[] {
    const statusIdx = flowIndex(input.status);
    const docs = new Set(
        (input.documents || [])
            .map((d) => String(d.docType || "").toUpperCase())
            .filter(Boolean)
    );

    const carrierDone =
        Boolean(String(input.carrierName || "").trim()) || statusIdx >= flowIndex("CARRIER_ASSIGNED");
    const rateConDone = hasType(docs, "RATE_CONFIRMATION") || statusIdx >= flowIndex("RATE_CON_GENERATED");
    const bolDone = hasType(docs, "BOL") || statusIdx >= flowIndex("CARRIER_ACCEPTED");
    const pickupDone = statusIdx >= flowIndex("PICKUP");

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
            need: "Assign Carrier first",
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
            id: "upload_pod",
            label: "Upload POD",
            docType: "POD",
            done: podDone,
            need: "Mark Loaded / Pickup first",
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

    const firstOpenAction = defs.findIndex((d) => !d.done && d.kind !== "status");
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
export function assertQuickActionAllowed(
    actionId: string,
    input: {
        status: string;
        carrierName?: string | null;
        customerPaidAt?: Date | string | null;
        carrierPaidAt?: Date | string | null;
        reviewCustomerSentAt?: Date | string | null;
        reviewCarrierSentAt?: Date | string | null;
        documents: Array<{ docType?: string | null }>;
    }
) {
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
        // Allow document regenerations (new PDF versions) from wizards / actions.
        if (row.docType) return;
        // Brokers may still send the remaining customer/carrier review email.
        if (actionId === "send_review_link") return;
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
