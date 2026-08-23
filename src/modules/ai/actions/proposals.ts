import type { ProposeAiActionInput } from "./types.js";
import type { AiActionType } from "./constants.js";

/**
 * Map operational recommendations → Phase 6 action proposals.
 * Still require explicit user confirmation before execution.
 */
export function proposalsFromOperationalRecommendations(input: {
    carrierId?: string;
    shipmentLeadId?: string;
    recommendations: Array<{
        id: string;
        text: string;
        reason: string;
        priority: string;
        source?: string;
    }>;
    carrierEmail?: string | null;
    aiRunId?: string;
}): ProposeAiActionInput[] {
    const out: ProposeAiActionInput[] = [];
    const targetType = input.carrierId ? "carrier" : input.shipmentLeadId ? "shipment" : "none";
    const targetId = input.carrierId || input.shipmentLeadId;
    if (!targetId || targetType === "none") return out;

    for (const rec of input.recommendations.slice(0, 5)) {
        const id = String(rec.id || "").toLowerCase();
        const text = `${rec.text} ${rec.reason}`.toLowerCase();

        let actionType: AiActionType = "CREATE_INTERNAL_NOTE";
        let title = rec.text;
        let payload: Record<string, unknown> = {
            noteText: `${rec.text} — ${rec.reason}`,
        };

        if (id.startsWith("comm-followup")) {
            if (input.carrierEmail) {
                actionType = "SEND_EMAIL";
                title = rec.text;
                payload = {
                    to: input.carrierEmail,
                    subject: "Follow-up — Green Logistics",
                    bodyText: `Hello,\n\n${rec.text}. ${rec.reason}\n\nPlease reply when available.\n\nThank you,\nGreen Logistics`,
                };
            } else {
                actionType = "CREATE_FOLLOW_UP";
                title = rec.text;
                payload = { noteText: rec.reason || rec.text };
            }
        } else if (
            id.startsWith("req-") ||
            id.startsWith("exp-") ||
            /request (updated |\/ upload )?(coi|noa|w-?9|agreement|mc|insurance|authority)/i.test(
                rec.text
            )
        ) {
            const docMatch =
                rec.text.match(/\b(COI|NOA|W-?9|MC_AUTHORITY|AGREEMENT|INSURANCE|AUTHORITY)\b/i) ||
                id.match(/req-(.+)|exp-(.+)/i);
            const documentType = String(
                docMatch?.[1] || docMatch?.[2] || "required document"
            ).toUpperCase();
            actionType = "REQUEST_DOCUMENT";
            title = `Request ${documentType}`;
            payload = {
                documentType,
                to: input.carrierEmail || undefined,
                subject: `Document request: ${documentType} — Green Logistics`,
                bodyText: `Hello,\n\n${rec.reason || rec.text}\n\nPlease provide ${documentType} at your earliest convenience.\n\nThank you,\nGreen Logistics`,
            };
        } else if (id.startsWith("rev-") || /review required|human review/i.test(text)) {
            if (rec.source && rec.source.length > 20) {
                actionType = "MARK_REVIEW_REQUIRED";
                title = "Mark for human review";
                payload = { jobId: rec.source, notes: rec.reason || rec.text };
            } else {
                actionType = "CREATE_INTERNAL_NOTE";
                title = "Add review note";
                payload = { noteText: `Review required: ${rec.reason || rec.text}` };
            }
        } else if (/follow[- ]?up/i.test(text)) {
            actionType = "CREATE_FOLLOW_UP";
            title = "Create follow-up";
            payload = { noteText: rec.reason || rec.text };
        }

        out.push({
            actionType,
            title: title.slice(0, 200),
            description: rec.text,
            reason: rec.reason,
            targetType,
            targetId,
            payload,
            sources: [{ type: "recommendation", id: rec.id, label: rec.text }],
            aiRunId: input.aiRunId,
            groundingHash: `${rec.id}:${rec.reason}`.slice(0, 200),
        });
    }

    return out;
}
