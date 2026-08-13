import { normalizeStatus } from "./shipment.lifecycle.js";

export type QuickActionState = "done" | "current" | "locked";

export type LoadQuickAction = {
    id: string;
    label: string;
    status?: string;
    docType?: string;
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
    documents: Array<{ docType?: string | null }>;
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
    const transitDone = statusIdx >= flowIndex("IN_TRANSIT");
    const deliveredDone = statusIdx >= flowIndex("DELIVERED");
    const podDone = hasType(docs, "POD") || statusIdx >= flowIndex("POD_UPLOADED");
    const customerInvDone =
        hasType(docs, "CUSTOMER_INVOICE") || statusIdx >= flowIndex("CUSTOMER_INVOICE");
    const carrierInvDone =
        hasType(docs, "CARRIER_INVOICE") || statusIdx >= flowIndex("CARRIER_PAYMENT");
    const closedDone = statusIdx >= flowIndex("CLOSED") || normalizeStatus(input.status) === "CLOSED";

    const defs: Array<{
        id: string;
        label: string;
        status?: string;
        docType?: string;
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
            id: "mark_transit",
            label: "Mark In Road",
            status: "IN_TRANSIT",
            done: transitDone,
            need: "Mark Loaded / Pickup first",
        },
        {
            id: "mark_delivered",
            label: "Mark Delivered",
            status: "DELIVERED",
            done: deliveredDone,
            need: "Mark In Road first",
        },
        {
            id: "upload_pod",
            label: "Generate POD",
            docType: "POD",
            done: podDone,
            need: "Mark Delivered first",
        },
        {
            id: "create_invoice",
            label: "Create Invoice",
            docType: "CUSTOMER_INVOICE",
            done: customerInvDone,
            need: "Generate POD first",
        },
        {
            id: "carrier_invoice",
            label: "Carrier Invoice",
            docType: "CARRIER_INVOICE",
            done: carrierInvDone,
            need: "Create Customer Invoice first",
        },
        {
            id: "close_load",
            label: "Close Load",
            status: "CLOSED",
            done: closedDone,
            need: "Create Carrier Invoice first",
        },
    ];

    const firstOpen = defs.findIndex((d) => !d.done);

    return defs.map((d, i) => {
        let state: QuickActionState;
        let blockedReason: string | undefined;
        if (d.done) {
            state = "done";
        } else if (i === firstOpen) {
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
    if (t === "CUSTOMER_INVOICE") return "create_invoice";
    if (t === "CARRIER_INVOICE") return "carrier_invoice";
    return null;
}
