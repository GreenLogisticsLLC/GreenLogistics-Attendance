import { classifyResponse } from "./classify.js";
import type {
    CommunicationRequest,
    WaitingInput,
    WaitingState,
} from "./types.js";

function iso(value: string | Date | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function computeWaitingState(input: WaitingInput): {
    waitingFor: WaitingState;
    waitingSince: string | null;
    openRequests: CommunicationRequest[];
    unresolvedItems: string[];
} {
    const messages = input.messages
        .map((m) => ({ ...m, atIso: iso(m.at) }))
        .filter((m) => Boolean(m.atIso))
        .sort((a, b) => String(a.atIso).localeCompare(String(b.atIso)));
    const inbound = messages.filter((m) => m.direction === "INBOUND");
    const outbound = messages.filter((m) => m.direction === "OUTBOUND");
    const lastInbound = inbound.at(-1);
    const lastOutbound = outbound.at(-1);
    const unresolvedItems: string[] = [];
    const openRequests: CommunicationRequest[] = [];

    for (const action of input.actions) {
        if (
            action.status !== "EXECUTED" ||
            !["REQUEST_DOCUMENT", "SEND_EMAIL"].includes(action.actionType)
        ) {
            continue;
        }
        const requestedAt = iso(action.executedAt);
        if (!requestedAt) {
            unresolvedItems.push(`Executed action ${action.actionId} has no execution timestamp`);
            continue;
        }
        const docType = String(action.documentType || "").toUpperCase() || null;
        const received = docType
            ? input.documents.find(
                  (d) =>
                      d.status === "CURRENT" &&
                      d.documentType.toUpperCase() === docType &&
                      Boolean(iso(d.uploadedAt)) &&
                      String(iso(d.uploadedAt)) >= requestedAt
              )
            : undefined;
        const response = inbound.find((m) => String(m.atIso) > requestedAt);
        const responseClass = received
            ? "DOCUMENT_RECEIVED"
            : response
              ? classifyResponse(`${response.subject || ""} ${response.snippet || ""}`)
              : "NO_RESPONSE";
        const lifecycle = received ? "RECEIVED" : response ? "RESPONDED" : "REQUESTED";
        if (!received) {
            openRequests.push({
                id: `request-${action.actionId}`,
                actionId: action.actionId,
                requestType: action.actionType,
                documentType: docType,
                requestedAt,
                lifecycle,
                responseClass,
                responseMessageId: response?.id || null,
                resolvedAt: null,
            });
        }
    }

    const review = (input.validations || []).find((v) => v.requiresReview);
    if (review) {
        return {
            waitingFor: "WAITING_FOR_INTERNAL_REVIEW",
            waitingSince: iso(review.createdAt),
            openRequests,
            unresolvedItems: [...unresolvedItems, "Document validation requires internal review"],
        };
    }
    const unsigned = (input.validations || []).find((v) => v.overallStatus === "UNSIGNED");
    if (input.missingSignature || unsigned) {
        return {
            waitingFor: "WAITING_FOR_SIGNATURE",
            waitingSince: iso(unsigned?.createdAt),
            openRequests,
            unresolvedItems: [...unresolvedItems, "Required signature is missing"],
        };
    }
    if (openRequests.some((r) => r.documentType && r.lifecycle === "REQUESTED")) {
        const request = openRequests.find((r) => r.documentType && r.lifecycle === "REQUESTED")!;
        return {
            waitingFor: "WAITING_FOR_DOCUMENT",
            waitingSince: request.requestedAt,
            openRequests,
            unresolvedItems: [...unresolvedItems, `${request.documentType} requested but not received`],
        };
    }
    const question = (input.customerQuestionEvents || [])
        .filter((e) => !e.resolved && iso(e.at))
        .sort((a, b) => String(iso(a.at)).localeCompare(String(iso(b.at))))
        .at(-1);
    if (question) {
        return {
            waitingFor: "WAITING_FOR_CUSTOMER",
            waitingSince: iso(question.at),
            openRequests,
            unresolvedItems: [...unresolvedItems, "Customer question has no recorded reply"],
        };
    }
    if (
        lastOutbound?.atIso &&
        (!lastInbound?.atIso || String(lastOutbound.atIso) > String(lastInbound.atIso))
    ) {
        return {
            waitingFor:
                lastOutbound.participant === "CARRIER"
                    ? "WAITING_FOR_CARRIER"
                    : "WAITING_FOR_RESPONSE",
            waitingSince: lastOutbound.atIso,
            openRequests,
            unresolvedItems,
        };
    }
    if (
        String(input.shipmentStatus || "").toUpperCase() === "FOLLOW_UP" &&
        (!lastInbound?.atIso ||
            (iso(input.shipmentUpdatedAt) &&
                String(lastInbound.atIso) < String(iso(input.shipmentUpdatedAt))))
    ) {
        return {
            waitingFor: "WAITING_FOR_RESPONSE",
            waitingSince: iso(input.shipmentUpdatedAt),
            openRequests,
            unresolvedItems,
        };
    }
    if (input.incomplete && !messages.length && !input.actions.length) {
        return {
            waitingFor: "INCOMPLETE",
            waitingSince: null,
            openRequests,
            unresolvedItems: [...unresolvedItems, "Communication evidence is incomplete"],
        };
    }
    return {
        waitingFor: "NO_OUTSTANDING_WAIT",
        waitingSince: null,
        openRequests,
        unresolvedItems,
    };
}
