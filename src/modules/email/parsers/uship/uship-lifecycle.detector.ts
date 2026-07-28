import { prisma } from "../../../../config/database.js";
import { domainEventEngine } from "../../../shipment/services/domain-event.engine.js";
import { shipmentService } from "../../../shipment/services/shipment.service.js";
import { sseEmitToRoles, sseEmitToUser } from "../../../crm/services/realtime.hub.js";
import { normalizeStatus } from "../../../shipment/shipment.lifecycle.js";
import { platformNotificationService } from "../../../shipment/services/platform-notification.service.js";

/**
 * Sprint D — classify uShip emails into lifecycle events and update the same Shipment Card.
 */

export type UshipLifecycleKind =
    | "BID_SUBMITTED"
    | "QUOTE_SUBMITTED"
    | "CUSTOMER_REPLIED"
    | "CUSTOMER_QUESTION"
    | "BID_UPDATED"
    | "CUSTOMER_ACCEPTED"
    | "LOAD_NUMBER_ASSIGNED"
    | "SHIPMENT_BOOKED"
    | "SHIPMENT_LOST"
    | "NEW_MESSAGE"
    | "UNKNOWN";

export type DetectedLifecycleEvent = {
    kind: UshipLifecycleKind;
    title: string;
    loadNumber?: string;
    domainEventType: string;
    targetStatus?: string;
};

function haystack(subject: string, body: string): string {
    return `${subject}\n${body}`.toLowerCase();
}

function extractLoadNumber(text: string): string | undefined {
    const patterns = [
        /load\s*(?:number|#|no\.?)[:\s#-]*([A-Z0-9-]{3,})/i,
        /load\s*#\s*([A-Z0-9-]{3,})/i,
        /\bLN[:\s#-]*([A-Z0-9-]{4,})/i,
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m?.[1]) return m[1].trim();
    }
    return undefined;
}

export function detectUshipLifecycleEvent(subject: string, body: string): DetectedLifecycleEvent {
    const h = haystack(subject, body);
    const loadNumber = extractLoadNumber(`${subject}\n${body}`);

    if (
        /shipment\s+lost|listing\s+closed|another\s+carrier|bid\s+not\s+selected|unfortunately.{0,40}lost|canceled|cancelled/.test(
            h
        )
    ) {
        return {
            kind: "SHIPMENT_LOST",
            title: "Shipment Lost",
            domainEventType: "SHIPMENT_LOST",
            targetStatus: "LOST",
        };
    }

    if (loadNumber || /load\s*(number|#)\s*(assigned|issued|is|created)/.test(h)) {
        return {
            kind: "LOAD_NUMBER_ASSIGNED",
            title: "Load Number Received",
            loadNumber,
            domainEventType: "LOAD_CREATED",
            targetStatus: "LOAD_CREATED",
        };
    }

    if (
        /customer\s+accepted|accepted\s+your\s+bid|your\s+bid\s+was\s+accepted|bid\s+accepted|booking\s+confirmed/.test(
            h
        )
    ) {
        return {
            kind: "CUSTOMER_ACCEPTED",
            title: "Bid Accepted",
            domainEventType: "CUSTOMER_ACCEPTED",
            targetStatus: "ACCEPTED",
        };
    }

    if (/\bbooked\b|shipment\s+booked|listing\s+booked/.test(h)) {
        return {
            kind: "SHIPMENT_BOOKED",
            title: "Shipment Booked",
            domainEventType: "CUSTOMER_ACCEPTED",
            targetStatus: "ACCEPTED",
        };
    }

    if (/bid\s+updated|updated\s+your\s+bid|quote\s+updated/.test(h)) {
        return {
            kind: "BID_UPDATED",
            title: "Bid Updated",
            domainEventType: "BID_SUBMITTED",
            targetStatus: "BID_SUBMITTED",
        };
    }

    if (/bid\s+submitted|you\s+submitted\s+a\s+bid|quote\s+submitted|submitted\s+a\s+quote/.test(h)) {
        return {
            kind: kindFromQuote(h),
            title: /quote/.test(h) ? "Quote Submitted" : "Bid Submitted",
            domainEventType: "BID_SUBMITTED",
            targetStatus: "BID_SUBMITTED",
        };
    }

    if (/customer\s+question|asked\s+a\s+question|new\s+question/.test(h)) {
        return {
            kind: "CUSTOMER_QUESTION",
            title: "Customer Question",
            domainEventType: "CUSTOMER_REPLIED",
            targetStatus: "CUSTOMER_REPLIED",
        };
    }

    if (/customer\s+replied|new\s+reply|replied\s+to\s+your|customer\s+responded|new\s+message\s+from/.test(h)) {
        return {
            kind: "CUSTOMER_REPLIED",
            title: "Customer Replied",
            domainEventType: "CUSTOMER_REPLIED",
            targetStatus: "CUSTOMER_REPLIED",
        };
    }

    if (/new\s+message|message\s+from\s+customer/.test(h)) {
        return {
            kind: "NEW_MESSAGE",
            title: "New Message",
            domainEventType: "CUSTOMER_REPLIED",
            targetStatus: "CUSTOMER_REPLIED",
        };
    }

    return {
        kind: "UNKNOWN",
        title: "uShip email",
        domainEventType: "STATUS_CHANGED",
    };
}

function kindFromQuote(h: string): UshipLifecycleKind {
    return /quote/.test(h) ? "QUOTE_SUBMITTED" : "BID_SUBMITTED";
}

const NOTIFY_KINDS = new Set<UshipLifecycleKind>([
    "CUSTOMER_REPLIED",
    "CUSTOMER_QUESTION",
    "CUSTOMER_ACCEPTED",
    "LOAD_NUMBER_ASSIGNED",
    "SHIPMENT_BOOKED",
    "SHIPMENT_LOST",
    "NEW_MESSAGE",
    "BID_SUBMITTED",
    "BID_UPDATED",
]);

/**
 * Apply detected lifecycle event onto the existing Shipment Card (never creates a new record).
 */
export async function applyUshipLifecycleEvent(input: {
    shipmentLeadId: string;
    subject: string;
    body: string;
    actorUserId?: string;
    gmailMessageId?: string;
    source?: string;
}) {
    const detected = detectUshipLifecycleEvent(input.subject, input.body);
    const shipment = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: input.shipmentLeadId },
    });
    if (!shipment) return { applied: false as const, detected };

    // Load number on SAME card
    if (detected.kind === "LOAD_NUMBER_ASSIGNED") {
        if (detected.loadNumber) {
            await shipmentService.applyLoadNumber({
                shipmentLeadId: input.shipmentLeadId,
                loadNumber: detected.loadNumber,
                actorUserId: input.actorUserId,
            });
        } else {
            await shipmentService.transitionStatus({
                shipmentLeadId: input.shipmentLeadId,
                status: "LOAD_CREATED",
                actorUserId: input.actorUserId,
                skipLifecycleCheck: true,
            });
            await domainEventEngine.emit({
                shipmentLeadId: input.shipmentLeadId,
                eventType: "LOAD_CREATED",
                title: detected.title,
                message: input.subject,
                actorUserId: input.actorUserId,
                payload: {
                    source: input.source || "uship_email",
                    gmailMessageId: input.gmailMessageId,
                    kind: detected.kind,
                },
                timelineStage: "LOAD_CREATED",
            });
        }
    } else if (detected.targetStatus) {
        const current = normalizeStatus(shipment.status);
        const target = normalizeStatus(detected.targetStatus);
        // Don't regress past load/dispatch/completed unless LOST
        const rank: Record<string, number> = {
            NEW: 0,
            UNASSIGNED: 0,
            AWAITING_ACCEPTANCE: 1,
            WORKING: 2,
            BID_SUBMITTED: 3,
            CUSTOMER_REPLIED: 4,
            ACCEPTED: 5,
            LOAD_CREATED: 6,
            DISPATCH: 7,
            COMPLETED: 8,
            CLOSED: 9,
            LOST: 9,
            FOLLOW_UP: 2,
        };
        const shouldUpdateStatus =
            detected.targetStatus === "LOST" ||
            (rank[target] ?? 0) >= (rank[current] ?? 0);

        if (shouldUpdateStatus && current !== target) {
            await shipmentService.transitionStatus({
                shipmentLeadId: input.shipmentLeadId,
                status: target,
                actorUserId: input.actorUserId,
                skipLifecycleCheck: true,
            });
        } else {
            await domainEventEngine.emit({
                shipmentLeadId: input.shipmentLeadId,
                eventType: detected.domainEventType,
                title: detected.title,
                message: input.subject,
                actorUserId: input.actorUserId,
                payload: {
                    source: input.source || "uship_email",
                    gmailMessageId: input.gmailMessageId,
                    kind: detected.kind,
                    statusUnchanged: true,
                    currentStatus: shipment.status,
                },
                timelineStage: detected.domainEventType,
            });
        }
    } else {
        await domainEventEngine.emit({
            shipmentLeadId: input.shipmentLeadId,
            eventType: detected.domainEventType,
            title: detected.title,
            message: input.subject,
            actorUserId: input.actorUserId,
            payload: {
                source: input.source || "uship_email",
                gmailMessageId: input.gmailMessageId,
                kind: detected.kind,
            },
            timelineStage: "USHIP_EMAIL",
        });
    }

    if (NOTIFY_KINDS.has(detected.kind)) {
        const payload = {
            type: "SHIPMENT_LIFECYCLE",
            kind: detected.kind,
            title: detected.title,
            shipmentLeadId: input.shipmentLeadId,
            greenOsShipmentId: shipment.greenOsShipmentId,
            shipmentNumber: shipment.greenOsShipmentId || input.shipmentLeadId.slice(0, 8),
            subject: input.subject,
            loadNumber: detected.loadNumber || shipment.loadNumber,
            at: new Date().toISOString(),
        };
        if (shipment.assignedBrokerId) {
            sseEmitToUser(shipment.assignedBrokerId, payload);
        }
        sseEmitToRoles(["Owner", "Manager", "Administrator", "Team Lead"], {
            ...payload,
            type: "SHIPMENT_LIFECYCLE_BROADCAST",
        });

        const typeMap: Record<string, string> = {
            CUSTOMER_REPLIED: "CUSTOMER_REPLIED",
            CUSTOMER_QUESTION: "CUSTOMER_REPLIED",
            NEW_MESSAGE: "CUSTOMER_REPLIED",
            CUSTOMER_ACCEPTED: "BID_ACCEPTED",
            SHIPMENT_BOOKED: "SHIPMENT_BOOKED",
            LOAD_NUMBER_ASSIGNED: "LOAD_NUMBER_RECEIVED",
            SHIPMENT_LOST: "SHIPMENT_LOST",
            BID_SUBMITTED: "BID_SUBMITTED",
            BID_UPDATED: "BID_SUBMITTED",
            QUOTE_SUBMITTED: "BID_SUBMITTED",
        };
        const nType = typeMap[detected.kind] || "TIMELINE_EVENT";
        const msg = `Shipment # ${shipment.greenOsShipmentId || input.shipmentLeadId.slice(0, 8)} — ${input.subject}`;
        if (shipment.assignedBrokerId) {
            await platformNotificationService
                .notifyUser({
                    userId: shipment.assignedBrokerId,
                    notificationType: nType,
                    title: detected.title,
                    message: msg,
                    shipmentLeadId: input.shipmentLeadId,
                    meta: { kind: detected.kind },
                })
                .catch(() => null);
        }
        await platformNotificationService
            .notifyRoles({
                roles: ["Owner", "Manager", "Administrator", "Team Lead"],
                notificationType: nType,
                title: detected.title,
                message: msg,
                shipmentLeadId: input.shipmentLeadId,
                excludeUserId: shipment.assignedBrokerId || undefined,
                meta: { kind: detected.kind },
            })
            .catch(() => null);
    }

    return { applied: true as const, detected };
}
