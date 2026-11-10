import { prisma } from "../../config/database.js";
import { NEW_SHIPMENT_ASSIGNMENT_ROLES } from "../../auth/roles.js";
import { domainEventEngine } from "../shipment/services/domain-event.engine.js";
import { ensureGreenOsShipmentId } from "../shipment/shipment.id.js";
import { platformNotificationService } from "../shipment/services/platform-notification.service.js";
import { sseEmitToRoles, sseEmitToUser } from "../crm/services/realtime.hub.js";
import {
    shipmentImportLogRepository,
    shipmentLeadRepository,
} from "../email/services/repositories.js";
import type { ShipmentLeadStatus } from "../email/models/types.js";
import { getInOfficeEmployeeIds } from "../../services/attendance-presence.service.js";
import { arrivedAfterShipmentCutoff, SHIPMENTS_FROM } from "../../services/shipment-cutoff.js";
import { config } from "../../config/env.js";
import { ASSIGNMENT_TIMEZONE, assignmentWasAfterHours, dayOffEmployeeIdsFromRows, isAfterHoursAssignment, nightAcceptanceDeadline, NIGHT_HOLD_UNTIL_OFFICE, chooseAssignmentPool } from "../../utils/helpers.js";
import { receivesNewShipments } from "./activity-window.js";
import { queuePlaces, syncQueueOrder, takeNextInQueue } from "./round-robin.js";
import { arrivalCountsFor, summarizeShipmentArrivals } from "./arrival-counts.js";
import {
    brokersAtOtherOfferCap,
    brokersDueForOtherOffer,
    otherRoundIsClosed,
} from "./other-round.js";
import { isLoadPhase, normalizeStatus } from "../shipment/shipment.lifecycle.js";
import { shipmentService } from "../shipment/services/shipment.service.js";

const ASSIGNMENT_ROLE_NAMES = [...NEW_SHIPMENT_ASSIGNMENT_ROLES];

/** Only Accept Shipment (and later work) keeps the lead. Open in uShip still times out. */
const KEPT_BY_BROKER = new Set([
    "WORKING",
    "FOLLOW_UP",
    "BID_SUBMITTED",
    "CUSTOMER_REPLIED",
    "ACCEPT_GREEN",
    "ACCEPTED",
    "LOAD_CREATED",
]);

const WAITING_TO_ASSIGN = [
    "NEW",
    "UNASSIGNED",
    "ASSIGNED",
    "AWAITING_ACCEPTANCE",
    "AGENT_OPEN",
] as const;

function shipmentArrivedAtNight(lead: {
    assignedAt?: Date | null;
    receivedAt?: Date | null;
    createdAt?: Date | null;
}): boolean {
    return assignmentWasAfterHours(lead, ASSIGNMENT_TIMEZONE);
}

function isHeldUntilOffice(deadline: Date | null | undefined): boolean {
    return Boolean(deadline && deadline.getTime() >= NIGHT_HOLD_UNTIL_OFFICE.getTime() - 86_400_000);
}

function isKeptByCurrentBroker(lead: { status: string; acceptedAt?: Date | null }) {
    if (lead.acceptedAt) return true;
    const status = normalizeStatus(lead.status);
    return KEPT_BY_BROKER.has(status) || isLoadPhase(status);
}

/**
 * One assignment at a time. Email import and the acceptance timer can both
 * hand out New shipments; without this they can read the same queue slot and
 * give two loads to one broker.
 */
let roundRobinTail: Promise<void> = Promise.resolve();
let rioSpreadRun: Promise<void> | null = null;

function withRoundRobinLock<T>(task: () => Promise<T>): Promise<T> {
    const run = roundRobinTail.then(task, task);
    roundRobinTail = run.then(
        () => undefined,
        () => undefined
    );
    return run;
}

/** Fresh imports only. Passing an Other shipment must not move this pointer. */
const QUEUE_NEW = "brokers";
/** Loads nobody accepted. Separate round-robin from New. */
const QUEUE_OTHER = "other";
/** Minutes to accept / react before load is passed to the next In Office broker. */
const ACCEPTANCE_MINUTES = 15;
/** Night shipments wait until the broker is In Office, then this many minutes to Accept. */
const NIGHT_ACCEPT_MINUTES = 30;
let lastPassedFlagRepairAt = 0;

export type EligibleBroker = {
    userId: string;
    username: string;
    firstName: string;
    lastName: string;
    employeeId: string;
    displayName: string;
};

function displayName(u: { firstName: string; lastName: string; username: string }) {
    const n = `${u.firstName || ""} ${u.lastName || ""}`.trim();
    return n || u.username;
}

/** Gary leads the fallback cycle when nobody is In Office; then everyone else A→Z. */
function isGaryBroker(b: { firstName: string; lastName: string; username: string }): boolean {
    const blob = `${b.firstName} ${b.lastName} ${b.username}`.toLowerCase();
    return blob.includes("gary");
}

function sortBrokersForRoundRobin(brokers: EligibleBroker[]): EligibleBroker[] {
    return [...brokers].sort((a, b) => {
        const aGary = isGaryBroker(a);
        const bGary = isGaryBroker(b);
        if (aGary && !bGary) return -1;
        if (!aGary && bGary) return 1;
        const fn = a.firstName.localeCompare(b.firstName, undefined, { sensitivity: "base" });
        if (fn !== 0) return fn;
        return a.lastName.localeCompare(b.lastName, undefined, { sensitivity: "base" });
    });
}

export type AssignmentPoolMode = "in_office" | "after_hours" | "none";

/**
 * Assignment Engine v1.0 — Round Robin among Brokers and Team Leads.
 * 17:00–01:00 Yerevan: In Office and a GreenOS click within 20 minutes.
 * 01:00–16:59 Yerevan: every Broker and Team Lead, in turn.
 * Manager, Accounting, and Owner never receive a shipment.
 */
export class AssignmentEngine {
    async startPipeline(shipmentLeadId: string) {
        const lead = await shipmentLeadRepository.findById(shipmentLeadId);
        if (!lead) return lead;
        // Assign only waiting leads (new import or parked Unassigned)
        if (lead.status !== "NEW" && lead.status !== "UNASSIGNED") return lead;

        if (lead.status === "NEW") {
            // SHIPMENT_IMPORTED is emitted by ShipmentService.markImported on create
            await ensureGreenOsShipmentId(shipmentLeadId).catch(() => null);
        }

        const other = Boolean(lead.wasEverReassigned || lead.isReassignment);
        const pick = await this.pickNextBrokerRoundRobin({
            queueKey: other ? QUEUE_OTHER : QUEUE_NEW,
        });
        if (!pick) {
            const parked =
                lead.status === "UNASSIGNED"
                    ? lead
                    : await shipmentLeadRepository.update(shipmentLeadId, {
                          status: "UNASSIGNED" as ShipmentLeadStatus,
                          assignedBrokerId: null,
                      });
            await this.pipelineLog(
                shipmentLeadId,
                "No broker In Office within the 20-minute window — lead marked UNASSIGNED"
            );
            await this.assignmentLog({
                shipmentLeadId,
                eventType: "NO_ELIGIBLE",
                message: "No eligible staff for assignment (role gate)",
            });
            if (lead.status !== "UNASSIGNED") {
                await domainEventEngine.emit({
                    shipmentLeadId,
                    eventType: "SHIPMENT_UNASSIGNED",
                    title: "Unassigned",
                    message: "No eligible staff for assignment (role gate)",
                    timelineStage: "SHIPMENT_UNASSIGNED",
                });
            }
            try {
                sseEmitToRoles(["Owner", "Manager", "Administrator"], {
                    type: "SHIPMENT_UNASSIGNED",
                    shipmentLeadId,
                    shipmentTitle: lead.shipmentTitle,
                    reason: "No eligible staff (role gate)",
                    at: new Date().toISOString(),
                });
            } catch {
                /* ignore */
            }
            return parked || lead;
        }

        const { broker, queueSnapshot } = pick;
        return this.assignLeadToBroker(
            shipmentLeadId,
            broker,
            queueSnapshot,
            lead.wasEverReassigned || lead.isReassignment
                ? { reassignFrom: "previous broker" }
                : undefined
        );
    }

    /**
     * Assign (or reassign) a lead to a broker with a fresh 20-minute acceptance window.
     */
    async assignLeadToBroker(
        shipmentLeadId: string,
        broker: EligibleBroker,
        queueSnapshot: string,
        options?: { reassignFrom?: string }
    ) {
        const lead = await shipmentLeadRepository.findById(shipmentLeadId);
        if (!lead) return lead;
        if (isKeptByCurrentBroker(lead)) {
            return lead;
        }

        const now = new Date();
        // Night is when we hand the shipment out, not when uShip sent the mail.
        const arrivedAtNight = isAfterHoursAssignment(now, ASSIGNMENT_TIMEZONE);
        const acceptanceDeadline = nightAcceptanceDeadline({
            arrivedAt: now,
            now,
            assigneeInOffice: false,
            timezone: ASSIGNMENT_TIMEZONE,
        });
        const windowLabel = !arrivedAtNight
            ? `${ACCEPTANCE_MINUTES}m`
            : "held overnight until Accept (or check-in starts 30m)";
        // Never treat "already has a broker id" alone as Other — a first night
        // handoff must stay New Shipment for Andy/Maddy and the rest of the roster.
        const isReassignment = Boolean(
            options?.reassignFrom || lead.wasEverReassigned || lead.isReassignment
        );
        const claimed = await prisma.shipmentLead.updateMany({
            where: {
                shipmentLeadId,
                acceptedAt: null,
                status: { in: [...WAITING_TO_ASSIGN] },
            },
            data: {
                status: "ASSIGNED",
                assignedBrokerId: broker.userId,
                assignedAt: new Date(),
                acceptanceDeadline,
                acceptedAt: null,
                isReassignment,
                ...(isReassignment ? { wasEverReassigned: true } : {}),
            },
        });
        if (claimed.count === 0) {
            return shipmentLeadRepository.findById(shipmentLeadId);
        }
        const assigned = await shipmentLeadRepository.findById(shipmentLeadId);
        if (!assigned) return lead;

        const reason = options?.reassignFrom
            ? `Reassigned from ${options.reassignFrom} → ${broker.displayName} (${windowLabel})`
            : `Round-robin assigned to ${broker.displayName} (${broker.userId}) — ${windowLabel}`;

        await this.pipelineLog(shipmentLeadId, reason);
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "BROKER_ASSIGNED",
            title: `Assigned to ${broker.displayName}`,
            message: options?.reassignFrom
                ? `Passed from ${options.reassignFrom} → ${broker.displayName}`
                : `Round Robin → ${broker.displayName}`,
            actorUserId: broker.userId,
            timelineStage: "BROKER_ASSIGNED",
            payload: {
                brokerId: broker.userId,
                employeeId: broker.employeeId,
                reassignFrom: options?.reassignFrom || null,
            },
        });
        await this.assignmentLog({
            shipmentLeadId,
            assignedUserId: broker.userId,
            assignedEmployeeId: broker.employeeId,
            eventType: options?.reassignFrom ? "REASSIGNED" : "ASSIGNED",
            message: reason,
            queueSnapshot,
        });

        const advanced = await prisma.shipmentLead.updateMany({
            where: {
                shipmentLeadId,
                acceptedAt: null,
                status: "ASSIGNED",
            },
            data: { status: "AWAITING_ACCEPTANCE" },
        });
        if (advanced.count === 0) {
            return shipmentLeadRepository.findById(shipmentLeadId);
        }
        const awaiting = await shipmentLeadRepository.findById(shipmentLeadId);
        await this.pipelineLog(shipmentLeadId, "Status → AWAITING_ACCEPTANCE");

        try {
            const gosId = await ensureGreenOsShipmentId(shipmentLeadId).catch(() => null);
            const leadRow = awaiting || assigned;
            const notifyPayload = {
                type: "SHIPMENT_ASSIGNED" as const,
                shipmentLeadId,
                greenOsShipmentId: gosId,
                shipmentNumber: gosId || shipmentLeadId.slice(0, 8),
                shipmentTitle: leadRow?.shipmentTitle || lead.shipmentTitle,
                vehicle: leadRow?.vehicle || leadRow?.category || lead.vehicle || lead.category || "",
                pickup: [leadRow?.pickupCity || lead.pickupCity, leadRow?.pickupState || lead.pickupState]
                    .filter(Boolean)
                    .join(", "),
                delivery: [
                    leadRow?.deliveryCity || lead.deliveryCity,
                    leadRow?.deliveryState || lead.deliveryState,
                ]
                    .filter(Boolean)
                    .join(", "),
                miles: leadRow?.miles ?? lead.miles ?? null,
                customer: leadRow?.customerName || lead.customerName || "",
                assignedAt: new Date().toISOString(),
                brokerName: broker.displayName,
                assignedBrokerId: broker.userId,
                message: `New Shipment Assigned — ${gosId || shipmentLeadId.slice(0, 8)}`,
            };
            sseEmitToUser(broker.userId, notifyPayload);
            const { notifyOpsAndOwningTeamLead } = await import(
                "../../services/team-notify.service.js"
            );
            await notifyOpsAndOwningTeamLead({
                assignedBrokerId: broker.userId,
                ssePayload: {
                    type: "SHIPMENT_ASSIGNED",
                    shipmentLeadId,
                    greenOsShipmentId: gosId,
                    shipmentNumber: gosId || shipmentLeadId.slice(0, 8),
                    shipmentTitle: leadRow?.shipmentTitle || lead.shipmentTitle,
                    brokerName: broker.displayName,
                    assignedAt: new Date().toISOString(),
                    message: `New Shipment Assigned — ${gosId || shipmentLeadId.slice(0, 8)} → ${broker.displayName}`,
                },
                broadcastType: "SHIPMENT_ASSIGNED_BROADCAST",
                notificationType: "SHIPMENT_ASSIGNED",
                title: options?.reassignFrom ? "Shipment reassigned" : "New Shipment Assigned",
                teamLeadTitle: options?.reassignFrom
                    ? "Shipment reassigned (your team)"
                    : "New Shipment Assigned (your team)",
                message: `Shipment # ${gosId || shipmentLeadId.slice(0, 8)} → ${broker.displayName}`,
                shipmentLeadId,
                meta: { greenOsShipmentId: gosId, brokerName: broker.displayName },
            });
            await platformNotificationService
                .notifyUser({
                    userId: broker.userId,
                    notificationType: "SHIPMENT_ASSIGNED",
                    title: "New Shipment Assigned",
                    message: `Shipment # ${gosId || shipmentLeadId.slice(0, 8)} — ${leadRow?.shipmentTitle || lead.shipmentTitle}`,
                    shipmentLeadId,
                    meta: { greenOsShipmentId: gosId },
                })
                .catch(() => null);
        } catch (err) {
            console.warn("[assignment] SSE notify failed:", err);
        }

        return awaiting || assigned;
    }

    /**
     * Keep New vs Other in sync for leads that already passed through another broker
     * (timeout, checkout, or a later round-robin assign that used to wipe the flag).
     */
    async repairPassedShipmentFlags() {
        const now = Date.now();
        if (lastPassedFlagRepairAt && now - lastPassedFlagRepairAt < 15_000) return;
        lastPassedFlagRepairAt = now;
        await prisma.shipmentLead.updateMany({
            where: { wasEverReassigned: true, isReassignment: false },
            data: { isReassignment: true },
        });

        const [fromLogs, fromEvents] = await Promise.all([
            prisma.assignmentLog.findMany({
                where: {
                    eventType: "REASSIGNED",
                    shipmentLeadId: { not: null },
                },
                select: { shipmentLeadId: true },
                distinct: ["shipmentLeadId"],
                take: 500,
            }),
            prisma.domainEvent.findMany({
                where: {
                    OR: [
                        { eventType: "REASSIGNED" },
                        {
                            eventType: "SHIPMENT_UNASSIGNED",
                            payloadJson: { contains: "previousBrokerId" },
                        },
                    ],
                },
                select: { shipmentLeadId: true },
                distinct: ["shipmentLeadId"],
                take: 500,
            }),
        ]);
        const ids = [
            ...new Set(
                [...fromLogs, ...fromEvents]
                    .map((row) => row.shipmentLeadId)
                    .filter((id): id is string => Boolean(id))
            ),
        ];
        if (!ids.length) return;
        await prisma.shipmentLead.updateMany({
            where: {
                shipmentLeadId: { in: ids },
                OR: [{ isReassignment: false }, { wasEverReassigned: false }],
            },
            data: { isReassignment: true, wasEverReassigned: true },
        });
    }

    private async otherOfferCounts(shipmentLeadId: string): Promise<Map<string, number>> {
        const logs = await prisma.assignmentLog.findMany({
            where: {
                shipmentLeadId,
                eventType: "REASSIGNED",
                assignedUserId: { not: null },
            },
            select: { assignedUserId: true },
        });
        const counts = new Map<string, number>();
        for (const log of logs) {
            const id = log.assignedUserId || "";
            if (!id) continue;
            counts.set(id, (counts.get(id) || 0) + 1);
        }
        return counts;
    }

    /** Other circle closes after two passes through the current eligible pool. */
    private async secondOfficeRoundClosed(shipmentLeadId: string, holderId: string): Promise<boolean> {
        const { eligible, mode } = await this.resolveEligibleBrokers();
        if (mode === "none" || !eligible.length) return false;
        const offerCounts = await this.otherOfferCounts(shipmentLeadId);
        return otherRoundIsClosed({
            eligibleIds: eligible.map((person) => person.userId),
            offerCounts,
            holderId,
        });
    }

    /** Brokers already at the 2-pass Other cap for this shipment (+ optional extra ids). */
    private async otherPassExcludeUserIds(
        shipmentLeadId: string,
        extraExclude: string[] = []
    ): Promise<string[]> {
        const { eligible } = await this.resolveEligibleBrokers();
        const offerCounts = await this.otherOfferCounts(shipmentLeadId);
        const atCap = brokersAtOtherOfferCap(
            eligible.map((person) => person.userId),
            offerCounts
        );
        return [...new Set([...extraExclude.filter(Boolean), ...atCap])];
    }

    /**
     * Nobody accepted after two Other passes. Remove the shipment from GreenOS
     * so it cannot rotate a third time (e.g. back to Rio).
     */
    private async purgeAfterOtherRound(
        lead: {
            shipmentLeadId: string;
            greenOsShipmentId?: string | null;
            shipmentTitle?: string | null;
        },
        holderId: string,
        holderLabel: string
    ): Promise<boolean> {
        const stillWaiting = await prisma.shipmentLead.findFirst({
            where: {
                shipmentLeadId: lead.shipmentLeadId,
                acceptedAt: null,
                assignedBrokerId: holderId,
                status: { in: ["ASSIGNED", "AWAITING_ACCEPTANCE", "AGENT_OPEN"] },
            },
            select: { shipmentLeadId: true },
        });
        if (!stillWaiting) return false;
        const gosId = lead.greenOsShipmentId || lead.shipmentLeadId.slice(0, 8);
        await this.pipelineLog(
            lead.shipmentLeadId,
            `Other shipment closed after two passes — ${holderLabel}; deleting from GreenOS`
        );
        await domainEventEngine.emit({
            shipmentLeadId: lead.shipmentLeadId,
            eventType: "STATUS_CHANGED",
            title: "Other shipment removed",
            message: `${holderLabel} closed the second pass. Nobody accepted. Shipment # ${gosId} was deleted from GreenOS.`,
            timelineStage: "STATUS_CHANGED",
            payload: { brokerId: holderId, reason: "OTHER_TWO_PASS_DELETE" },
        });
        await this.assignmentLog({
            shipmentLeadId: lead.shipmentLeadId,
            assignedUserId: holderId,
            eventType: "ROUND_DECLINED",
            message: `Other two-pass closed by ${holderLabel} — purged`,
        });
        sseEmitToUser(holderId, {
            type: "SHIPMENT_UNASSIGNED",
            shipmentLeadId: lead.shipmentLeadId,
            greenOsShipmentId: lead.greenOsShipmentId,
            shipmentTitle: lead.shipmentTitle,
            removedFromYourQueue: true,
            reason: "Other shipment went through everyone twice — removed from GreenOS",
            at: new Date().toISOString(),
        });
        await platformNotificationService
            .notifyUser({
                userId: holderId,
                notificationType: "ACCEPTANCE_MISSED",
                title: "Other shipment removed",
                message: `Shipment # ${gosId} went through everyone twice with no Accept and was deleted from GreenOS.`,
                meta: { greenOsShipmentId: lead.greenOsShipmentId },
            })
            .catch(() => null);
        const purged = await shipmentService.purgeShipmentLead(lead.shipmentLeadId);
        return purged;
    }

    async processDueAcceptances() {
        await this.repairPassedShipmentFlags();
        const now = new Date();
        // 1) Reclaim loads not yet accepted whose assigned broker left Office.
        //    Open in uShip does not keep the lead — only Accept Shipment does.
        const awaiting = await prisma.shipmentLead.findMany({
            where: {
                status: { in: ["AWAITING_ACCEPTANCE", "ASSIGNED", "AGENT_OPEN"] },
                acceptedAt: null,
                assignedBrokerId: { not: null },
            },
            take: 100,
        });
        for (const lead of awaiting) {
            if (shipmentArrivedAtNight(lead) || isHeldUntilOffice(lead.acceptanceDeadline)) {
                continue;
            }
            const brokerId = lead.assignedBrokerId!;
            const stillEligible = (await this.listEligibleBrokers()).some(
                (b) => b.userId === brokerId
            );
            if (stillEligible) continue;
            const latest = await shipmentLeadRepository.findById(lead.shipmentLeadId);
            if (!latest || isKeptByCurrentBroker(latest)) continue;
            // Broker checked out / not eligible — pass to someone In Office now.
            await this.pipelineLog(
                lead.shipmentLeadId,
                "Assigned broker is not In Office — reclaiming for round-robin"
            );
            const reclaimed = await prisma.shipmentLead.updateMany({
                where: {
                    shipmentLeadId: lead.shipmentLeadId,
                    acceptedAt: null,
                    status: { in: ["ASSIGNED", "AWAITING_ACCEPTANCE", "AGENT_OPEN"] },
                    assignedBrokerId: brokerId,
                },
                data: {
                    status: "UNASSIGNED",
                    assignedBrokerId: null,
                    acceptanceDeadline: null,
                    isReassignment: true,
                    wasEverReassigned: true,
                },
            });
            if (reclaimed.count === 0) continue;
            await domainEventEngine.emit({
                shipmentLeadId: lead.shipmentLeadId,
                eventType: "SHIPMENT_UNASSIGNED",
                title: "Reclaimed — broker not In Office",
                message: "Previous assignee left Office / not eligible; waiting for In Office broker",
                timelineStage: "SHIPMENT_UNASSIGNED",
                payload: { previousBrokerId: brokerId },
            });
            // Remove from the previous broker's My Shipments immediately.
            sseEmitToUser(brokerId, {
                type: "SHIPMENT_UNASSIGNED",
                shipmentLeadId: lead.shipmentLeadId,
                greenOsShipmentId: lead.greenOsShipmentId,
                shipmentTitle: lead.shipmentTitle,
                reason: "Broker not In Office — removed from your queue",
                removedFromYourQueue: true,
                at: new Date().toISOString(),
            });
        }

        // 2) Not accepted within 15 minutes → next In Office broker.
        // Open in uShip still counts as waiting. Only Accept Shipment keeps the lead.
        const fifteenAgo = new Date(now.getTime() - ACCEPTANCE_MINUTES * 60_000);
        const expired = await prisma.shipmentLead.findMany({
            where: {
                acceptedAt: null,
                assignedBrokerId: { not: null },
                OR: [
                    {
                        status: { in: ["ASSIGNED", "AWAITING_ACCEPTANCE", "AGENT_OPEN"] },
                        acceptanceDeadline: { lt: now },
                    },
                    {
                        status: "AGENT_OPEN",
                        acceptanceDeadline: null,
                        assignedAt: { lt: fifteenAgo },
                    },
                ],
            },
            take: 50,
        });

        let reassigned = 0;
        const afterHoursNow = isAfterHoursAssignment(now, ASSIGNMENT_TIMEZONE);
        for (const lead of expired) {
            if (isHeldUntilOffice(lead.acceptanceDeadline)) continue;
            const latest = await shipmentLeadRepository.findById(lead.shipmentLeadId);
            if (!latest || isKeptByCurrentBroker(latest)) continue;
            // Overnight (01:00–16:59): never pass night New Shipments — even if a
            // short deadline leaked through while Andy/Maddy were already In Office.
            // After check-in during office hours, armed 30m windows still expire.
            if (afterHoursNow && shipmentArrivedAtNight(latest)) continue;
            const timeoutMinutes = ACCEPTANCE_MINUTES;
            const previousBrokerId = lead.assignedBrokerId!;
            const previousUser = await prisma.user.findUnique({
                where: { userId: previousBrokerId },
                select: { firstName: true, lastName: true, username: true },
            });
            const previousLabel = previousUser
                ? `${previousUser.firstName || ""} ${previousUser.lastName || ""}`.trim() ||
                  previousUser.username
                : "broker";
            const gosId = lead.greenOsShipmentId || lead.shipmentLeadId.slice(0, 8);

            if (await this.secondOfficeRoundClosed(lead.shipmentLeadId, previousBrokerId)) {
                const purged = await this.purgeAfterOtherRound(lead, previousBrokerId, previousLabel);
                if (purged) {
                    reassigned += 1;
                    continue;
                }
            }

            await this.pipelineLog(
                lead.shipmentLeadId,
                `No reaction from ${previousLabel} within ${timeoutMinutes}m — reassigning`
            );
            await domainEventEngine.emit({
                shipmentLeadId: lead.shipmentLeadId,
                eventType: "STATUS_CHANGED",
                title: "Acceptance missed — reassigning",
                message: `${previousLabel} did not accept within ${timeoutMinutes} minutes`,
                timelineStage: "STATUS_CHANGED",
                payload: {
                    previousBrokerId,
                    previousBrokerName: previousLabel,
                    reason: "ACCEPTANCE_TIMEOUT",
                },
            });

            const missPayload = {
                type: "ACCEPTANCE_MISSED",
                shipmentLeadId: lead.shipmentLeadId,
                greenOsShipmentId: lead.greenOsShipmentId,
                shipmentNumber: gosId,
                brokerName: previousLabel,
                message: `${previousLabel} did not accept shipment # ${gosId} in time — reassigning`,
                at: new Date().toISOString(),
            };
            sseEmitToUser(previousBrokerId, missPayload);
            await platformNotificationService
                .notifyUser({
                    userId: previousBrokerId,
                    notificationType: "ACCEPTANCE_MISSED",
                    title: "Shipment reassigned",
                    message: `You did not accept shipment # ${gosId} within ${timeoutMinutes} minutes — it was passed to the next broker`,
                    // No shipmentLeadId — card now belongs to another broker; avoid Forbidden on open.
                    meta: { greenOsShipmentId: lead.greenOsShipmentId },
                })
                .catch(() => null);

            const { notifyOpsAndOwningTeamLead } = await import(
                "../../services/team-notify.service.js"
            );
            await notifyOpsAndOwningTeamLead({
                assignedBrokerId: previousBrokerId,
                ssePayload: missPayload,
                broadcastType: "ACCEPTANCE_MISSED_BROADCAST",
                notificationType: "ACCEPTANCE_MISSED",
                title: "Acceptance missed — reassigning",
                teamLeadTitle: "Team broker missed acceptance — reassigning",
                message: `${previousLabel} did not accept shipment # ${gosId} — passing to next In Office broker`,
                shipmentLeadId: lead.shipmentLeadId,
                meta: {
                    greenOsShipmentId: lead.greenOsShipmentId,
                    brokerName: previousLabel,
                },
            });

            const otherExclude = await this.otherPassExcludeUserIds(lead.shipmentLeadId, [
                previousBrokerId,
            ]);
            const pick = await this.pickNextBrokerRoundRobin({
                queueKey: QUEUE_OTHER,
                excludeUserIds: otherExclude,
            });

            if (!pick) {
                // Nobody left under the 2-pass Other cap — delete instead of a 3rd lap.
                const offerCounts = await this.otherOfferCounts(lead.shipmentLeadId);
                const { eligible } = await this.resolveEligibleBrokers();
                const stillDue = brokersDueForOtherOffer(
                    eligible.map((person) => person.userId),
                    offerCounts
                ).filter((id) => id !== previousBrokerId);
                if (stillDue.length === 0) {
                    const purged = await this.purgeAfterOtherRound(
                        lead,
                        previousBrokerId,
                        previousLabel
                    );
                    if (purged) {
                        reassigned += 1;
                        continue;
                    }
                }
                // No other broker In Office — keep the lead with the same broker.
                // Extend the acceptance deadline by another ACCEPTANCE_MINUTES so the
                // scheduler does not fire again immediately on the next tick.
                const extended = await prisma.shipmentLead.updateMany({
                    where: {
                        shipmentLeadId: lead.shipmentLeadId,
                        acceptedAt: null,
                        status: { in: ["ASSIGNED", "AWAITING_ACCEPTANCE", "AGENT_OPEN"] },
                    },
                    data: {
                        acceptanceDeadline: new Date(now.getTime() + ACCEPTANCE_MINUTES * 60_000),
                    },
                });
                if (extended.count === 0) continue;
                await this.pipelineLog(
                    lead.shipmentLeadId,
                    `No other broker In Office — keeping with ${previousLabel} until another broker arrives`
                );
                await domainEventEngine.emit({
                    shipmentLeadId: lead.shipmentLeadId,
                    eventType: "STATUS_CHANGED",
                    title: "Waiting — sole broker",
                    message: `${previousLabel} is the only broker In Office — shipment stays until another broker checks in`,
                    timelineStage: "STATUS_CHANGED",
                    payload: { previousBrokerId, reason: "SOLE_BROKER_EXTENDED" },
                });
                // Notify the broker so they know it's still theirs
                sseEmitToUser(previousBrokerId, {
                    type: "ACCEPTANCE_EXTENDED",
                    shipmentLeadId: lead.shipmentLeadId,
                    greenOsShipmentId: lead.greenOsShipmentId,
                    shipmentTitle: lead.shipmentTitle,
                    message: `You are the only broker In Office — shipment #${gosId} stays with you until another broker arrives`,
                    at: new Date().toISOString(),
                });
                continue;
            }

            const after = await this.assignLeadToBroker(
                lead.shipmentLeadId,
                pick.broker,
                pick.queueSnapshot,
                { reassignFrom: previousLabel }
            );
            if (after && after.assignedBrokerId === pick.broker.userId && !isKeptByCurrentBroker(after)) {
                reassigned += 1;
            }
        }
        return reassigned || expired.length;
    }

    /**
     * Assigned broker or team lead declines a waiting shipment now.
     * The 15-minute timer still passes loads that nobody declines.
     */
    async declineShipment(shipmentLeadId: string, actorUserId: string) {
        const lead = await shipmentLeadRepository.findById(shipmentLeadId);
        if (!lead) {
            throw Object.assign(new Error("Shipment not found"), { status: 404 });
        }
        if (lead.assignedBrokerId !== actorUserId) {
            throw Object.assign(new Error("Only the assigned broker can decline this shipment"), {
                status: 403,
            });
        }
        const waiting = ["ASSIGNED", "AWAITING_ACCEPTANCE", "AGENT_OPEN"];
        if (lead.acceptedAt || !waiting.includes(String(lead.status || "")) || isKeptByCurrentBroker(lead)) {
            throw Object.assign(new Error("This shipment can no longer be declined"), { status: 422 });
        }
        const previousUser = await prisma.user.findUnique({
            where: { userId: actorUserId },
            select: { firstName: true, lastName: true, username: true },
        });
        const previousLabel = previousUser
            ? `${previousUser.firstName || ""} ${previousUser.lastName || ""}`.trim() || previousUser.username
            : "broker";
        const gosId = lead.greenOsShipmentId || lead.shipmentLeadId.slice(0, 8);
        if (await this.secondOfficeRoundClosed(lead.shipmentLeadId, actorUserId)) {
            const purged = await this.purgeAfterOtherRound(lead, actorUserId, previousLabel);
            if (purged) {
                return { passed: false, unassigned: false, declined: true, deleted: true, assignedTo: previousLabel };
            }
        }
        await this.pipelineLog(lead.shipmentLeadId, `${previousLabel} declined this shipment`);
        await domainEventEngine.emit({
            shipmentLeadId: lead.shipmentLeadId,
            eventType: "STATUS_CHANGED",
            title: "Broker declined",
            message: `${previousLabel} declined shipment # ${gosId}`,
            timelineStage: "STATUS_CHANGED",
            payload: { previousBrokerId: actorUserId, reason: "BROKER_DECLINED" },
        });
        const otherExclude = await this.otherPassExcludeUserIds(lead.shipmentLeadId, [actorUserId]);
        const pick = await this.pickNextBrokerRoundRobin({
            queueKey: QUEUE_OTHER,
            excludeUserIds: otherExclude,
        });
        if (!pick) {
            const offerCounts = await this.otherOfferCounts(lead.shipmentLeadId);
            const { eligible } = await this.resolveEligibleBrokers();
            const stillDue = brokersDueForOtherOffer(
                eligible.map((person) => person.userId),
                offerCounts
            ).filter((id) => id !== actorUserId);
            if (stillDue.length === 0) {
                const purged = await this.purgeAfterOtherRound(lead, actorUserId, previousLabel);
                if (purged) {
                    return {
                        passed: false,
                        unassigned: false,
                        declined: true,
                        deleted: true,
                        assignedTo: previousLabel,
                    };
                }
            }
            const parked = await prisma.shipmentLead.updateMany({
                where: {
                    shipmentLeadId: lead.shipmentLeadId,
                    acceptedAt: null,
                    assignedBrokerId: actorUserId,
                    status: { in: waiting },
                },
                data: {
                    status: "UNASSIGNED",
                    assignedBrokerId: null,
                    acceptanceDeadline: null,
                    isReassignment: true,
                    wasEverReassigned: true,
                },
            });
            if (parked.count === 0) {
                throw Object.assign(new Error("This shipment can no longer be declined"), { status: 422 });
            }
            sseEmitToUser(actorUserId, {
                type: "SHIPMENT_UNASSIGNED",
                shipmentLeadId: lead.shipmentLeadId,
                removedFromYourQueue: true,
                reason: "You declined this shipment",
                at: new Date().toISOString(),
            });
            return { passed: false, unassigned: true };
        }
        const after = await this.assignLeadToBroker(lead.shipmentLeadId, pick.broker, pick.queueSnapshot, {
            reassignFrom: previousLabel,
        });
        sseEmitToUser(actorUserId, {
            type: "SHIPMENT_UNASSIGNED",
            shipmentLeadId: lead.shipmentLeadId,
            removedFromYourQueue: true,
            reason: "You declined this shipment",
            at: new Date().toISOString(),
        });
        return { passed: Boolean(after), unassigned: false, assignedTo: pick.broker.displayName };
    }

    async markQuoteSent(shipmentLeadId: string) {
        const updated = await shipmentLeadRepository.update(shipmentLeadId, {
            status: "QUOTE_SENT" satisfies ShipmentLeadStatus,
            quoteSentAt: new Date(),
        });
        await this.pipelineLog(shipmentLeadId, "Status → QUOTE_SENT");
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "BID_SUBMITTED",
            title: "Bid Submitted",
            message: "Status → Bid Submitted",
            timelineStage: "BID_SUBMITTED",
        });
        return updated;
    }

    async closeLead(shipmentLeadId: string, outcome: "WON" | "LOST") {
        const updated = await shipmentLeadRepository.update(shipmentLeadId, {
            status: outcome === "WON" ? "COMPLETED" : "LOST",
            closedAt: new Date(),
        });
        await this.pipelineLog(shipmentLeadId, `Status → ${outcome}`);
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: outcome === "WON" ? "SHIPMENT_COMPLETED" : "SHIPMENT_LOST",
            title: outcome === "WON" ? "Completed" : "Lost",
            message: `Status → ${outcome === "WON" ? "COMPLETED" : "LOST"}`,
            timelineStage: outcome === "WON" ? "SHIPMENT_COMPLETED" : "SHIPMENT_LOST",
        });
        return updated;
    }

    /** Public snapshot for managers / debugging. */
    async getQueueStatus() {
        const { eligible, mode } = await this.resolveEligibleBrokers();
        const state = await this.loadQueueState();
        const synced = syncQueueOrder(
            state.orderedUserIds,
            eligible.map((e) => e.userId),
            state.nextIndex
        );
        const modeLabel =
            mode === "after_hours"
                ? "01:00–16:59 Yerevan — every Broker and Team Lead, in turn"
                : mode === "in_office"
                  ? "17:00–01:00 Yerevan — In Office and active within 20 minutes"
                  : "17:00–01:00 Yerevan — nobody is In Office";
        return {
            version: "1.0",
            algorithm: "round_robin_sequential",
            assignmentMode: mode,
            assignmentModeLabel: modeLabel,
            rules: [
                "From 17:00 to 01:00 Yerevan, NEW shipments go only to Brokers and Team Leads who are In Office and clicked within 20 minutes",
                "From 01:00 to 16:59 Yerevan, NEW shipments go to every Broker and Team Lead in turn, even if they are not In Office",
                "Manager, Accounting, Owner, and every other role never receive NEW shipments",
                "Fresh NEW imports are assigned before passed-along (reassigned) loads",
                "If nobody eligible is In Office → shipments stay UNASSIGNED until someone checks in",
                "When eligible staff checks in → they join the queue and pending NEW/UNASSIGNED drain",
                "Waiting leads not accepted in 15 minutes go to the next In Office person — Open in uShip still passes; only Accept Shipment keeps the load",
                "Gmail recommended for uShip updates but does not block receiving shipments",
            ],
            heart: "Attendance → Assignment Queue → CRM Shipment",
            eligible: eligible.map((e) => ({
                userId: e.userId,
                name: e.displayName,
                employeeId: e.employeeId,
            })),
            queueOrder: synced.orderedUserIds.map((id) => {
                const e = eligible.find((x) => x.userId === id);
                return { userId: id, name: e?.displayName || id };
            }),
            nextIndex: synced.nextIndex,
            nextBroker: synced.orderedUserIds.length
                ? eligible.find((e) => e.userId === synced.orderedUserIds[synced.nextIndex % synced.orderedUserIds.length])
                      ?.displayName || null
                : null,
        };
    }

    /**
     * Manager / Owner view of the live circle.
     * Names and turn only — no shipment titles or ids.
     */
    async getAssignmentBoard() {
        const { eligible, mode } = await this.resolveEligibleBrokers();
        const eligibleIds = eligible.map((person) => person.userId);
        const [newState, otherState, lastNew, lastOther, staff] = await Promise.all([
            this.loadQueueState(QUEUE_NEW),
            this.loadQueueState(QUEUE_OTHER),
            prisma.assignmentLog.findFirst({
                where: { eventType: "ASSIGNED", assignedUserId: { not: null } },
                orderBy: { createdAt: "desc" },
                select: { assignedUserId: true, createdAt: true },
            }),
            prisma.assignmentLog.findFirst({
                where: { eventType: "REASSIGNED", assignedUserId: { not: null } },
                orderBy: { createdAt: "desc" },
                select: { assignedUserId: true, createdAt: true },
            }),
            prisma.user.findMany({
                where: {
                    isActive: true,
                    role: { roleName: { in: ["Broker", "Team Lead"] } },
                },
                include: { role: true, employee: true },
                orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
            }),
        ]);
        const arrivalRows = await prisma.$queryRaw<
            Array<{
                userId: string;
                eventType: string;
                shipmentId: string;
                assignedBrokerId: string | null;
                acceptedAt: Date | string | null;
            }>
        >`
            SELECT DISTINCT
                l.assigned_user_id AS userId,
                l.event_type AS eventType,
                s.shipment_lead_id AS shipmentId,
                s.assigned_broker_id AS assignedBrokerId,
                s.accepted_at AS acceptedAt
            FROM shipment_leads s
            INNER JOIN assignment_logs l ON l.shipment_lead_id = s.shipment_lead_id
            WHERE l.event_type IN ('ASSIGNED', 'REASSIGNED')
              AND l.assigned_user_id IS NOT NULL
              AND s.status != 'DELETED_FROM_CUSTOMER'
              AND (
                    s.received_at >= ${SHIPMENTS_FROM}
                    OR (s.received_at IS NULL AND s.created_at >= ${SHIPMENTS_FROM})
                  )
        `;
        const arrivalLeads = new Map<
            string,
            { assignedBrokerId: string | null; acceptedAt: Date | string | null }
        >();
        for (const row of arrivalRows) {
            arrivalLeads.set(row.shipmentId, {
                assignedBrokerId: row.assignedBrokerId,
                acceptedAt: row.acceptedAt,
            });
        }
        const arrivals = summarizeShipmentArrivals({
            logs: arrivalRows.map((row) => ({
                userId: row.userId,
                eventType: row.eventType,
                shipmentId: row.shipmentId,
            })),
            leads: arrivalLeads,
        });
        const newSynced = syncQueueOrder(newState.orderedUserIds, eligibleIds, newState.nextIndex);
        const otherSynced = syncQueueOrder(
            otherState.orderedUserIds,
            eligibleIds,
            otherState.nextIndex
        );
        const paint = (
            synced: { orderedUserIds: string[]; nextIndex: number },
            lastUserId: string | null,
            lastAt: Date | null
        ) => {
            const places = queuePlaces(synced.orderedUserIds, synced.nextIndex, lastUserId);
            const people = places.map((row) => {
                const person = eligible.find((item) => item.userId === row.userId);
                const received = arrivalCountsFor(arrivals, row.userId);
                return {
                    userId: row.userId,
                    name: person?.displayName || "Broker",
                    position: row.position,
                    place: row.place,
                    newShipments: received.newShipments,
                    newAccepted: received.newAccepted,
                    newDeclined: received.newDeclined,
                    newWaiting: received.newWaiting,
                    otherShipments: received.otherShipments,
                };
            });
            const next = people.find((row) => row.place === "next") || null;
            return {
                people,
                nextName: next?.name || null,
                lastReceivedName:
                    people.find((row) => row.place === "received")?.name || null,
                lastReceivedAt: lastAt,
            };
        };
        const outsideIds = staff.filter((user) => !eligibleIds.includes(user.userId));
        const officeIds = await getInOfficeEmployeeIds(
            outsideIds.map((user) => user.employeeId || "").filter(Boolean)
        );
        const now = new Date();
        const outside = outsideIds.map((user) => {
            const inOffice = Boolean(user.employeeId && officeIds.has(user.employeeId));
            const clicked = receivesNewShipments(
                user.role.roleName,
                user.greenOsActivityAt,
                now
            );
            let reason = "Not in office";
            if (!user.employeeId) reason = "No attendance link";
            else if (inOffice && !clicked) reason = "No click for 20 minutes";
            else if (!inOffice && !clicked) reason = "Not in office and no click for 20 minutes";
            const received = arrivalCountsFor(arrivals, user.userId);
            return {
                userId: user.userId,
                name: displayName(user),
                role: user.role.roleName,
                reason,
                newShipments: received.newShipments,
                newAccepted: received.newAccepted,
                newDeclined: received.newDeclined,
                newWaiting: received.newWaiting,
                otherShipments: received.otherShipments,
            };
        });
        return {
            assignmentMode: mode,
            assignmentModeLabel:
                mode === "after_hours"
                    ? "01:00–16:59 Yerevan — every Broker and Team Lead, in turn"
                    : mode === "in_office"
                      ? "17:00–01:00 Yerevan — In Office and active within 20 minutes"
                      : "17:00–01:00 Yerevan — nobody is In Office",
            newQueue: paint(newSynced, lastNew?.assignedUserId || null, lastNew?.createdAt || null),
            otherQueue: paint(
                otherSynced,
                lastOther?.assignedUserId || null,
                lastOther?.createdAt || null
            ),
            outside,
        };
    }

    async listAssignmentLogs(limit = 100) {
        return prisma.assignmentLog.findMany({
            orderBy: { createdAt: "desc" },
            take: limit,
        });
    }

    /**
     * Attendance card ENTRY → In Office → join end of assignment queue.
     * Attendance card EXIT → Out of Office → leave queue immediately.
     * Owner/Manager "Set In Office" passes ownerOverride so day-off and idle
     * GreenOS clicks do not keep the broker out of New / Other.
     */
    async onBrokerEnteredOffice(
        employeeId: string,
        options?: { ownerOverride?: boolean }
    ) {
        const user = await this.findBrokerUserByEmployeeId(employeeId);
        if (!user) return null;

        const ownerOverride = options?.ownerOverride === true;
        if (!ownerOverride && (await this.dayOffEmployeeIds([employeeId])).has(employeeId)) {
            console.info(
                `[assignment] ${displayName(user)} arrived after 17:00 Yerevan — Day off, not added to New or Other`
            );
            return null;
        }

        if (ownerOverride) {
            await this.setOwnerInOfficeOverride(employeeId, true);
            await prisma.user
                .update({
                    where: { userId: user.userId },
                    data: { greenOsActivityAt: new Date() },
                })
                .catch(() => undefined);
        }

        const joinedNew = await this.joinQueue(QUEUE_NEW, user.userId);
        await this.joinQueue(QUEUE_OTHER, user.userId);
        if (joinedNew.joined || ownerOverride) {
            await this.assignmentLog({
                assignedUserId: user.userId,
                assignedEmployeeId: employeeId,
                eventType: "QUEUE_JOIN",
                message: ownerOverride
                    ? `${displayName(user)} set In Office by Owner/Manager → New and Other queues (New position ${joinedNew.orderedUserIds.length})`
                    : `${displayName(user)} In Office → added to New and Other queues (New position ${joinedNew.orderedUserIds.length})`,
                queueSnapshot: JSON.stringify({
                    order: joinedNew.orderedUserIds,
                    nextIndex: joinedNew.nextIndex,
                }),
            });
            console.log(
                `[assignment] QUEUE_JOIN ${displayName(user)}${ownerOverride ? " (owner override)" : ""} — New queue size ${joinedNew.orderedUserIds.length}`
            );
        }

        const armed = await this.armNightAcceptanceWindows(user.userId);
        if (armed > 0) {
            console.log(
                `[assignment] ${displayName(user)} In Office — ${armed} night shipment(s) now have ${NIGHT_ACCEPT_MINUTES}m to Accept`
            );
        }

        // New queue first. Other uses its own pointer and does not consume a New turn.
        const drained = await this.assignPendingNewLeads(3);
        await this.assignPendingOtherLeads(3);
        if (drained > 0) {
            console.log(
                `[assignment] drained ${drained} pending shipment(s) after ${displayName(user)} In Office`
            );
        }

        return { orderedUserIds: joinedNew.orderedUserIds, nextIndex: joinedNew.nextIndex };
    }

    /**
     * While after-hours (01:00–16:59), night New Shipments that still have a short
     * 30-minute deadline (old bug when the broker was already In Office) go back
     * on overnight hold so Andy/Maddy do not lose their New list overnight.
     * During office hours this no-ops so check-in-armed 30m windows can expire.
     */
    async holdOpenNightShipments(): Promise<number> {
        const now = new Date();
        if (!isAfterHoursAssignment(now, ASSIGNMENT_TIMEZONE)) return 0;

        const waiting = await prisma.shipmentLead.findMany({
            where: {
                acceptedAt: null,
                assignedBrokerId: { not: null },
                status: { in: ["ASSIGNED", "AWAITING_ACCEPTANCE", "AGENT_OPEN"] },
                acceptanceDeadline: { not: null, lt: NIGHT_HOLD_UNTIL_OFFICE },
                AND: [arrivedAfterShipmentCutoff],
            },
            take: 200,
            select: {
                shipmentLeadId: true,
                assignedAt: true,
                receivedAt: true,
                createdAt: true,
                acceptanceDeadline: true,
            },
        });
        let held = 0;
        for (const lead of waiting) {
            if (!shipmentArrivedAtNight(lead)) continue;
            if (isHeldUntilOffice(lead.acceptanceDeadline)) continue;
            const updated = await prisma.shipmentLead.updateMany({
                where: {
                    shipmentLeadId: lead.shipmentLeadId,
                    acceptedAt: null,
                    status: { in: ["ASSIGNED", "AWAITING_ACCEPTANCE", "AGENT_OPEN"] },
                },
                data: { acceptanceDeadline: NIGHT_HOLD_UNTIL_OFFICE },
            });
            if (updated.count > 0) held += 1;
        }
        if (held > 0) {
            console.log(
                `[assignment] held ${held} night New Shipment(s) so night-shift brokers keep them`
            );
        }
        return held;
    }

    /**
     * Night shipments stay with the assignee until they check in.
     * Check-in starts a 30-minute Accept window.
     */
    async armNightAcceptanceWindows(userId: string): Promise<number> {
        const now = new Date();
        const updated = await prisma.shipmentLead.updateMany({
            where: {
                assignedBrokerId: userId,
                acceptedAt: null,
                status: { in: ["ASSIGNED", "AWAITING_ACCEPTANCE", "AGENT_OPEN"] },
                acceptanceDeadline: { gte: NIGHT_HOLD_UNTIL_OFFICE },
            },
            data: {
                acceptanceDeadline: new Date(now.getTime() + NIGHT_ACCEPT_MINUTES * 60_000),
            },
        });
        return updated.count;
    }

    /**
     * Assign waiting NEW / first-time UNASSIGNED shipments via Round Robin.
     * Other loads use assignPendingOtherLeads and a separate queue pointer.
     */
    async assignPendingNewLeads(
        limit = 50,
        options?: { includeOther?: boolean }
    ): Promise<number> {
        const unassignedPool = {
            status: "UNASSIGNED" as const,
            OR: [{ assignedBrokerId: null }, { assignedBrokerId: "" }],
        };
        const freshFilter = {
            wasEverReassigned: false,
            isReassignment: false,
        };
        const [freshNew, unassignedFresh] = await Promise.all([
            prisma.shipmentLead.findMany({
                where: {
                    status: "NEW",
                    OR: [{ assignedBrokerId: null }, { assignedBrokerId: "" }],
                    AND: [arrivedAfterShipmentCutoff],
                },
                orderBy: { createdAt: "asc" },
                take: limit,
                select: { shipmentLeadId: true },
            }),
            prisma.shipmentLead.findMany({
                where: { ...unassignedPool, ...freshFilter, AND: [arrivedAfterShipmentCutoff] },
                orderBy: { createdAt: "asc" },
                take: limit,
                select: { shipmentLeadId: true },
            }),
        ]);
        const seen = new Set<string>();
        const pending: Array<{ shipmentLeadId: string }> = [];
        for (const row of [...freshNew, ...unassignedFresh]) {
            if (seen.has(row.shipmentLeadId)) continue;
            seen.add(row.shipmentLeadId);
            pending.push(row);
            if (pending.length >= limit) break;
        }

        let assigned = 0;
        for (const row of pending) {
            const eligible = await this.listEligibleBrokers();
            if (!eligible.length) break;
            const before = await shipmentLeadRepository.findById(row.shipmentLeadId);
            await this.startPipeline(row.shipmentLeadId);
            const after = await shipmentLeadRepository.findById(row.shipmentLeadId);
            if (
                after &&
                after.assignedBrokerId &&
                after.status !== "NEW" &&
                after.status !== "UNASSIGNED"
            ) {
                assigned += 1;
            } else if (before && after && after.status === "UNASSIGNED") {
                break;
            }
        }
        if (options?.includeOther) {
            assigned += await this.assignPendingOtherLeads(limit);
        }
        return assigned;
    }

    /** Passed-along loads. Does not move the New shipment pointer. */
    async assignPendingOtherLeads(limit = 50): Promise<number> {
        const rows = await prisma.shipmentLead.findMany({
            where: {
                status: "UNASSIGNED",
                OR: [{ assignedBrokerId: null }, { assignedBrokerId: "" }],
                AND: [
                    arrivedAfterShipmentCutoff,
                    { OR: [{ wasEverReassigned: true }, { isReassignment: true }] },
                ],
            },
            orderBy: { createdAt: "asc" },
            take: limit,
            select: { shipmentLeadId: true },
        });
        let assigned = 0;
        for (const row of rows) {
            const eligible = await this.listEligibleBrokers();
            if (!eligible.length) break;
            const before = await shipmentLeadRepository.findById(row.shipmentLeadId);
            await this.startPipeline(row.shipmentLeadId);
            const after = await shipmentLeadRepository.findById(row.shipmentLeadId);
            if (
                after &&
                after.assignedBrokerId &&
                after.status !== "NEW" &&
                after.status !== "UNASSIGNED"
            ) {
                assigned += 1;
            } else if (before && after && after.status === "UNASSIGNED") {
                break;
            }
        }
        return assigned;
    }

    async onBrokerLeftOffice(employeeId: string) {
        const user = await this.findBrokerUserByEmployeeId(employeeId);
        if (!user) return null;

        await this.setOwnerInOfficeOverride(employeeId, false);

        const left = await this.leaveQueue(QUEUE_NEW, user.userId);
        await this.leaveQueue(QUEUE_OTHER, user.userId);
        if (!left) return null;
        const { orderedUserIds, nextIndex } = left;
        await this.assignmentLog({
            assignedUserId: user.userId,
            assignedEmployeeId: employeeId,
            eventType: "QUEUE_LEAVE",
            message: `${displayName(user)} Out of Office → removed from assignment queue`,
            queueSnapshot: JSON.stringify({ order: orderedUserIds, nextIndex }),
        });
        console.log(
            `[assignment] QUEUE_LEAVE ${displayName(user)} — queue size ${orderedUserIds.length}`
        );
        return { orderedUserIds, nextIndex };
    }

    private async findBrokerUserByEmployeeId(employeeId: string) {
        let user = await prisma.user.findFirst({
            where: {
                employeeId,
                role: { roleName: { in: ASSIGNMENT_ROLE_NAMES } },
            },
            include: { role: true },
        });
        if (user) return user;

        const emp = await prisma.employee.findUnique({ where: { employeeId } });
        if (!emp) return null;

        const candidates = await prisma.user.findMany({
            where: { role: { roleName: { in: ASSIGNMENT_ROLE_NAMES } } },
            include: { role: true },
        });
        const fn = emp.firstName.trim().toLowerCase();
        const ln = emp.lastName.trim().toLowerCase();
        const matches = candidates.filter(
            (u) =>
                u.firstName.trim().toLowerCase() === fn &&
                u.lastName.trim().toLowerCase() === ln
        );
        if (matches.length !== 1) return null;

        user = matches[0];
        try {
            await prisma.user.update({
                where: { userId: user.userId },
                data: { employeeId },
            });
        } catch {
            /* ignore */
        }
        return user;
    }

    /**
     * 17:00–01:00 Yerevan: Brokers and Team Leads who are In Office and clicked within 20 minutes.
     * 01:00–16:59 Yerevan: every linked Broker and Team Lead, in turn.
     * Manager, Accounting, and Owner are not loaded into this pool.
     * If nobody qualifies during work hours, NEW shipments stay UNASSIGNED until check-in.
     * Gmail is NOT required. `availableForAssignment` is ignored.
     */
    async listEligibleBrokers(options?: { forceAllLinked?: boolean }): Promise<EligibleBroker[]> {
        const { eligible } = await this.resolveEligibleBrokers(options);
        return eligible;
    }

    /**
     * Night of 5 Nov 2026 (01:00–17:00 Yerevan). Shipments handed to Rich were
     * treated as daytime because the email time fell in office hours, so the
     * 15-minute timer passed them on. Put unaccepted ones back on his account.
     */
    async restoreRichNightShipments(): Promise<void> {
        const mark = "2026-11-05-rich-night-2";
        const existing = await prisma.setting.findUnique({
            where: {
                category_settingKey: { category: "ops", settingKey: "rich_night_restore" },
            },
        });
        if (existing?.settingValue?.startsWith(mark)) return;

        const users = await prisma.user.findMany({
            where: { isActive: true },
            select: {
                userId: true,
                firstName: true,
                lastName: true,
                employeeId: true,
                role: { select: { roleName: true } },
            },
        });
        const richUsers = users.filter((user) => {
            const name = `${user.firstName} ${user.lastName}`.trim().toLowerCase();
            return user.firstName.trim().toLowerCase() === "rich" || name.startsWith("rich ");
        });
        if (!richUsers.length) {
            console.warn("[assignment] Rich not found — night restore will retry");
            return;
        }
        const nightStart = new Date("2026-11-04T21:00:00.000Z");
        const nightEnd = new Date("2026-11-05T13:00:00.000Z");
        const richIds = richUsers.map((user) => user.userId);
        const logs = await prisma.assignmentLog.findMany({
            where: {
                assignedUserId: { in: richIds },
                eventType: { in: ["ASSIGNED", "REASSIGNED"] },
                shipmentLeadId: { not: null },
                createdAt: { gte: nightStart, lt: nightEnd },
            },
            orderBy: { createdAt: "asc" },
            select: {
                shipmentLeadId: true,
                assignedUserId: true,
                eventType: true,
                createdAt: true,
            },
        });
        const firstGive = new Map<
            string,
            { userId: string; eventType: string; createdAt: Date }
        >();
        for (const log of logs) {
            if (!log.shipmentLeadId || !log.assignedUserId) continue;
            if (firstGive.has(log.shipmentLeadId)) continue;
            firstGive.set(log.shipmentLeadId, {
                userId: log.assignedUserId,
                eventType: log.eventType,
                createdAt: log.createdAt,
            });
        }
        const terminal = new Set([
            "DELETED_FROM_CUSTOMER",
            "LOST",
            "ACCEPTED_ANOTHER_COMPANY",
            "NO_LONGER_NEEDED",
            "VOIDED",
            "COMPLETED",
            "CLOSED",
        ]);
        const waiting = new Set([
            "NEW",
            "UNASSIGNED",
            "ASSIGNED",
            "AWAITING_ACCEPTANCE",
            "AGENT_OPEN",
        ]);
        let restored = 0;
        let already = 0;
        let kept = 0;
        let skipped = 0;
        for (const [shipmentLeadId, give] of firstGive) {
            const lead = await prisma.shipmentLead.findUnique({
                where: { shipmentLeadId },
                select: {
                    shipmentLeadId: true,
                    greenOsShipmentId: true,
                    shipmentTitle: true,
                    status: true,
                    assignedBrokerId: true,
                    acceptedAt: true,
                },
            });
            if (!lead) {
                skipped += 1;
                continue;
            }
            const status = String(lead.status || "");
            if (terminal.has(status)) {
                skipped += 1;
                continue;
            }
            const holder = lead.assignedBrokerId || "";
            const returnable = waiting.has(status) || status === "ROUND_DECLINED";
            if (holder === give.userId && (lead.acceptedAt || !returnable)) {
                already += 1;
                continue;
            }
            const acceptedBySomeoneElse = Boolean(lead.acceptedAt) && holder !== give.userId;
            if (acceptedBySomeoneElse || (!returnable && holder !== give.userId)) {
                kept += 1;
                continue;
            }
            const wasAlreadyWaitingHere = holder === give.userId && waiting.has(status);
            if (wasAlreadyWaitingHere) already += 1;
            const rich = richUsers.find((user) => user.userId === give.userId);
            let inOffice = false;
            if (rich?.employeeId) {
                const office = await getInOfficeEmployeeIds([rich.employeeId]);
                inOffice = office.has(rich.employeeId);
            }
            const acceptanceDeadline = nightAcceptanceDeadline({
                arrivedAt: give.createdAt,
                now: new Date(),
                assigneeInOffice: inOffice,
                timezone: ASSIGNMENT_TIMEZONE,
            });
            const passed = give.eventType === "REASSIGNED";
            await prisma.shipmentLead.update({
                where: { shipmentLeadId },
                data: {
                    assignedBrokerId: give.userId,
                    status: "AWAITING_ACCEPTANCE",
                    assignedAt: give.createdAt,
                    acceptanceDeadline,
                    acceptedAt: null,
                    isReassignment: passed,
                    wasEverReassigned: passed,
                },
            });
            if (holder !== give.userId || !waiting.has(status)) {
                restored += 1;
                const label = rich
                    ? `${rich.firstName} ${rich.lastName}`.trim()
                    : "Rich";
                await this.pipelineLog(
                    shipmentLeadId,
                    `Returned to ${label} — night shipment from 5 Nov was passed on before he could accept`
                );
                await domainEventEngine.emit({
                    shipmentLeadId,
                    eventType: "BROKER_ASSIGNED",
                    title: `Returned to ${label}`,
                    message: `Night shipment put back on ${label}`,
                    actorUserId: give.userId,
                    timelineStage: "BROKER_ASSIGNED",
                    payload: { brokerId: give.userId, reason: "RICH_NIGHT_RESTORE" },
                });
                sseEmitToUser(give.userId, {
                    type: "SHIPMENT_ASSIGNED",
                    shipmentLeadId,
                    greenOsShipmentId: lead.greenOsShipmentId,
                    shipmentTitle: lead.shipmentTitle,
                    at: new Date().toISOString(),
                });
            }
        }
        const summary = `${mark} restored=${restored} already=${already} kept=${kept} skipped=${skipped} gives=${firstGive.size}`;
        await prisma.setting.upsert({
            where: {
                category_settingKey: { category: "ops", settingKey: "rich_night_restore" },
            },
            create: {
                category: "ops",
                settingKey: "rich_night_restore",
                settingValue: summary,
                description: "Night shipments returned to Rich",
            },
            update: {
                settingValue: summary,
                description: "Night shipments returned to Rich",
            },
        });
        console.log(`[assignment] ${summary}`);
    }

    /**
     * One boot after 01:00 piled every waiting shipment on Rio Clark.
     * Take those unaccepted loads off his list and hand them out in turn.
     * Accepted work stays. Runs once.
     */
    async spreadRioClarkWaitingShipments(): Promise<void> {
        if (rioSpreadRun) return rioSpreadRun;
        rioSpreadRun = this.spreadRioClarkWaitingShipmentsOnce().finally(() => {
            rioSpreadRun = null;
        });
        return rioSpreadRun;
    }

    private async spreadRioClarkWaitingShipmentsOnce(): Promise<void> {
        const mark = "2026-11-04-rio-waiting-spread";
        const existing = await prisma.setting.findUnique({
            where: {
                category_settingKey: { category: "ops", settingKey: "rio_waiting_spread" },
            },
        });
        if (existing?.settingValue === mark) return;

        const users = await prisma.user.findMany({
            where: { isActive: true },
            select: { userId: true, firstName: true, lastName: true },
        });
        const rios = users.filter(
            (user) =>
                user.firstName.trim().toLowerCase() === "rio" &&
                user.lastName.trim().toLowerCase() === "clark"
        );
        if (!rios.length) {
            console.warn("[assignment] Rio Clark not found — waiting spread will retry next boot");
            return;
        }

        let left = 0;
        let moved = 0;
        for (const rio of rios) {
            const result = await this.spreadWaitingShipmentsOf(rio.userId, "Rio Clark");
            moved += result.moved;
            left += result.left;
        }
        if (left > 0) {
            console.warn(
                `[assignment] ${left} waiting shipment(s) still on Rio Clark — will retry next boot`
            );
            return;
        }

        await prisma.setting.upsert({
            where: {
                category_settingKey: { category: "ops", settingKey: "rio_waiting_spread" },
            },
            create: {
                category: "ops",
                settingKey: "rio_waiting_spread",
                settingValue: mark,
                description: `Waiting shipments taken off Rio Clark and handed out in turn (${moved})`,
            },
            update: {
                settingValue: mark,
                description: `Waiting shipments taken off Rio Clark and handed out in turn (${moved})`,
            },
        });
        console.log(`[assignment] Rio Clark waiting spread done — ${moved} shipment(s)`);
    }

    /** Unaccepted waiting loads leave this broker and go to everyone else, one by one. */
    async spreadWaitingShipmentsOf(
        userId: string,
        label: string
    ): Promise<{ moved: number; left: number }> {
        const waiting = await prisma.shipmentLead.findMany({
            where: {
                assignedBrokerId: userId,
                acceptedAt: null,
                status: { in: ["ASSIGNED", "AWAITING_ACCEPTANCE", "AGENT_OPEN"] },
                AND: [arrivedAfterShipmentCutoff],
            },
            orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }],
            select: {
                shipmentLeadId: true,
                greenOsShipmentId: true,
                shipmentTitle: true,
            },
        });

        let moved = 0;
        let left = 0;
        const handed: string[] = [];
        for (const row of waiting) {
            const pick = await this.pickNextBrokerRoundRobin({
                queueKey: QUEUE_NEW,
                excludeUserIds: [userId],
                forceAllLinked: true,
            });
            if (!pick) {
                left += 1;
                console.warn(
                    `[assignment] nobody else to take ${row.greenOsShipmentId || row.shipmentTitle} off ${label}`
                );
                continue;
            }
            const cleared = await prisma.shipmentLead.updateMany({
                where: {
                    shipmentLeadId: row.shipmentLeadId,
                    assignedBrokerId: userId,
                    acceptedAt: null,
                    status: { in: ["ASSIGNED", "AWAITING_ACCEPTANCE", "AGENT_OPEN"] },
                },
                data: {
                    status: "UNASSIGNED",
                    assignedBrokerId: null,
                    acceptanceDeadline: null,
                    isReassignment: false,
                    wasEverReassigned: false,
                },
            });
            if (cleared.count === 0) continue;
            sseEmitToUser(userId, {
                type: "SHIPMENT_UNASSIGNED",
                shipmentLeadId: row.shipmentLeadId,
                greenOsShipmentId: row.greenOsShipmentId,
                shipmentTitle: row.shipmentTitle,
                removedFromYourQueue: true,
                reason: "Passed to the team in turn",
                at: new Date().toISOString(),
            });
            await this.pipelineLog(
                row.shipmentLeadId,
                `Taken off ${label} and handed out in turn`
            );
            const after = await this.assignLeadToBroker(
                row.shipmentLeadId,
                pick.broker,
                pick.queueSnapshot
            );
            if (after?.assignedBrokerId && after.assignedBrokerId !== userId) {
                moved += 1;
                handed.push(
                    `${row.greenOsShipmentId || row.shipmentTitle} → ${pick.broker.displayName}`
                );
            } else {
                left += 1;
            }
        }
        if (waiting.length) {
            console.log(
                `[assignment] ${label}: moved ${moved}, left ${left}. ${handed.join("; ")}`
            );
        }
        return { moved, left };
    }

    async resolveEligibleBrokers(options?: { forceAllLinked?: boolean }): Promise<{
        eligible: EligibleBroker[];
        mode: AssignmentPoolMode;
    }> {
        const [users, activeEmployees] = await Promise.all([
            prisma.user.findMany({
                where: {
                    role: { roleName: { in: ASSIGNMENT_ROLE_NAMES } },
                    isActive: true,
                },
                include: { role: true, employee: true, brokerGmailAccount: true },
                orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
            }),
            prisma.employee.findMany({
                where: { status: "ACTIVE" },
                select: { employeeId: true, firstName: true, lastName: true },
            }),
        ]);

        const allLinked: EligibleBroker[] = [];
        const employeeIdsToCheck: string[] = [];
        const linkUpdates: Array<{ userId: string; employeeId: string }> = [];

        const now = new Date();
        const afterHours = isAfterHoursAssignment(now, ASSIGNMENT_TIMEZONE);
        const ownerOverrides = await this.ownerInOfficeOverrides();

        for (const user of users) {
            const employeeId = this.resolveEmployeeIdSync(user, activeEmployees);
            const override =
                Boolean(employeeId) && ownerOverrides.has(employeeId as string);
            if (
                !options?.forceAllLinked &&
                !afterHours &&
                !override &&
                !receivesNewShipments(user.role.roleName, user.greenOsActivityAt, now)
            ) {
                continue;
            }
            if (!employeeId) continue;

            if (employeeId && !user.employeeId) {
                linkUpdates.push({ userId: user.userId, employeeId });
            }

            const gmail = user.brokerGmailAccount;
            const gmailOk = Boolean(
                gmail &&
                    gmail.status === "CONNECTED" &&
                    gmail.isActive &&
                    gmail.refreshToken
            );
            if (!gmailOk) {
                console.warn(
                    `[assignment] ${displayName(user)} eligible but Gmail not connected — still in round-robin (connect Gmail for uShip status updates)`
                );
            }

            const entry: EligibleBroker = {
                userId: user.userId,
                username: user.username,
                firstName: user.firstName,
                lastName: user.lastName,
                employeeId: employeeId || "",
                displayName: displayName(user),
            };
            allLinked.push(entry);
            if (employeeId) employeeIdsToCheck.push(employeeId);
        }

        if (linkUpdates.length) {
            void Promise.all(
                linkUpdates.map(({ userId, employeeId }) =>
                    prisma.user
                        .update({ where: { userId }, data: { employeeId } })
                        .catch(() => undefined)
                )
            );
        }

        const inOfficeIds = await getInOfficeEmployeeIds(employeeIdsToCheck);
        const inOffice = allLinked.filter((entry) => entry.employeeId && inOfficeIds.has(entry.employeeId));
        if (options?.forceAllLinked && allLinked.length > 0) {
            return {
                eligible: sortBrokersForRoundRobin(allLinked),
                mode: "after_hours",
            };
        }
        const pool = chooseAssignmentPool({
            afterHours,
            linkedCount: allLinked.length,
            inOfficeCount: inOffice.length,
        });

        if (pool === "after_hours") {
            console.info(
                `[assignment] 01:00–16:59 Yerevan — round-robin across all ${allLinked.length} Brokers and Team Leads`
            );
            return {
                eligible: sortBrokersForRoundRobin(allLinked),
                mode: "after_hours",
            };
        }

        if (pool === "in_office") {
            const dayOff = await this.dayOffEmployeeIds(inOffice.map((entry) => entry.employeeId));
            const working = inOffice.filter(
                (entry) =>
                    ownerOverrides.has(entry.employeeId) || !dayOff.has(entry.employeeId)
            );
            if (working.length) {
                return {
                    eligible: sortBrokersForRoundRobin(working),
                    mode: "in_office",
                };
            }
        }

        // Nobody linked+In Office. Surface Attendance badges that ARE In Office but
        // not linked to a Broker user — those people will never receive Instant Alerts.
        try {
            const { getAttendanceWorkDate } = await import("../../utils/helpers.js");
            const { config } = await import("../../config/env.js");
            const workDate = getAttendanceWorkDate(new Date(), config.timezone);
            const orphanInside = await prisma.attendanceSession.findMany({
                where: {
                    workDate,
                    currentStatus: "INSIDE_OFFICE",
                    employee: { status: "ACTIVE" },
                    ...(employeeIdsToCheck.length
                        ? { employeeId: { notIn: employeeIdsToCheck } }
                        : {}),
                },
                include: {
                    employee: {
                        select: { firstName: true, lastName: true, employeeNumber: true },
                    },
                },
                take: 20,
            });
            if (orphanInside.length) {
                const names = orphanInside
                    .map(
                        (s) =>
                            `${s.employee.firstName} ${s.employee.lastName}`.trim() ||
                            s.employee.employeeNumber
                    )
                    .join(", ");
                console.warn(
                    `[assignment] In Office on Attendance but NOT linked to a Broker user (no Instant Alerts): ${names}`
                );
            }
        } catch {
            /* best-effort diagnostic */
        }

        console.info(
            `[assignment] no eligible staff In Office — parking NEW shipments as UNASSIGNED until check-in (${allLinked.length} linked staff offline; roles=${ASSIGNMENT_ROLE_NAMES.join(",")})`
        );
        return { eligible: [], mode: "none" };
    }

    private async dayOffEmployeeIds(employeeIds: string[]): Promise<Set<string>> {
        const ids = [...new Set(employeeIds.filter(Boolean))];
        if (!ids.length) return new Set();
        const now = new Date();
        const rows = await prisma.attendanceSession.findMany({
            where: { employeeId: { in: ids }, firstEntry: { not: null } },
            select: { employeeId: true, firstEntry: true },
        });
        return new Set(dayOffEmployeeIdsFromRows(rows, now));
    }

    /** Owner/Manager Set In Office — stay eligible until Mark Out, even on a day off. */
    private async ownerInOfficeOverrides(): Promise<Set<string>> {
        const row = await prisma.setting.findUnique({
            where: {
                category_settingKey: {
                    category: "assignment",
                    settingKey: "owner_in_office_overrides",
                },
            },
        });
        if (!row?.settingValue) return new Set();
        try {
            const parsed = JSON.parse(row.settingValue) as Record<string, string>;
            return new Set(Object.keys(parsed || {}));
        } catch {
            return new Set();
        }
    }

    private async setOwnerInOfficeOverride(employeeId: string, enabled: boolean) {
        if (!employeeId) return;
        const key = {
            category_settingKey: {
                category: "assignment" as const,
                settingKey: "owner_in_office_overrides",
            },
        };
        const row = await prisma.setting.findUnique({ where: key });
        let map: Record<string, string> = {};
        if (row?.settingValue) {
            try {
                map = JSON.parse(row.settingValue) as Record<string, string>;
            } catch {
                map = {};
            }
        }
        if (enabled) map[employeeId] = new Date().toISOString();
        else delete map[employeeId];
        const value = JSON.stringify(map);
        if (row) {
            await prisma.setting.update({
                where: key,
                data: {
                    settingValue: value,
                    description: "Owner/Manager forced In Office for the shipment queue",
                },
            });
        } else {
            await prisma.setting.create({
                data: {
                    category: "assignment",
                    settingKey: "owner_in_office_overrides",
                    settingValue: value,
                    description: "Owner/Manager forced In Office for the shipment queue",
                },
            });
        }
    }

    private resolveEmployeeIdSync(
        user: {
            userId: string;
            employeeId: string | null;
            employee?: { employeeId: string; status: string } | null;
            firstName: string;
            lastName: string;
        },
        activeEmployees: Array<{ employeeId: string; firstName: string; lastName: string }>
    ): string | null {
        if (user.employeeId && user.employee?.status === "ACTIVE") {
            return user.employeeId;
        }
        if (user.employeeId) {
            const emp = activeEmployees.find((e) => e.employeeId === user.employeeId);
            if (emp) return emp.employeeId;
        }

        const fn = user.firstName.trim().toLowerCase();
        const ln = user.lastName.trim().toLowerCase();
        const matches = activeEmployees.filter(
            (e) =>
                e.firstName.trim().toLowerCase() === fn &&
                e.lastName.trim().toLowerCase() === ln
        );
        if (matches.length === 1) return matches[0].employeeId;

        // First-name-only when unique among ACTIVE employees (common badge mismatch).
        if (fn.length >= 2) {
            const byFirst = activeEmployees.filter(
                (e) => e.firstName.trim().toLowerCase() === fn
            );
            if (byFirst.length === 1) return byFirst[0].employeeId;
        }
        return null;
    }

    private async resolveEmployeeId(user: {
        userId: string;
        employeeId: string | null;
        employee?: { employeeId: string; status: string } | null;
        firstName: string;
        lastName: string;
    }): Promise<string | null> {
        if (user.employeeId && user.employee?.status === "ACTIVE") {
            return user.employeeId;
        }
        if (user.employeeId) {
            const emp = await prisma.employee.findFirst({
                where: { employeeId: user.employeeId, status: "ACTIVE" },
            });
            if (emp) return emp.employeeId;
        }

        // Fallback: match by first + last name (case-insensitive)
        const all = await prisma.employee.findMany({ where: { status: "ACTIVE" } });
        const fn = user.firstName.trim().toLowerCase();
        const ln = user.lastName.trim().toLowerCase();
        const matches = all.filter(
            (e) => e.firstName.trim().toLowerCase() === fn && e.lastName.trim().toLowerCase() === ln
        );
        if (matches.length === 1) return matches[0].employeeId;
        if (fn.length >= 2) {
            const byFirst = all.filter((e) => e.firstName.trim().toLowerCase() === fn);
            if (byFirst.length === 1) return byFirst[0].employeeId;
        }
        return null;
    }

    private pickNextBrokerRoundRobin(options?: {
        queueKey?: string;
        excludeUserIds?: string[];
        forceAllLinked?: boolean;
    }): Promise<{
        broker: EligibleBroker;
        queueSnapshot: string;
    } | null> {
        return withRoundRobinLock(() => this.pickNextBrokerRoundRobinLocked(options));
    }

    private async pickNextBrokerRoundRobinLocked(options?: {
        queueKey?: string;
        excludeUserIds?: string[];
        forceAllLinked?: boolean;
    }): Promise<{
        broker: EligibleBroker;
        queueSnapshot: string;
    } | null> {
        const queueKey = options?.queueKey || QUEUE_NEW;
        const exclude = options?.excludeUserIds || [];
        const eligible = await this.listEligibleBrokers({
            forceAllLinked: options?.forceAllLinked,
        });
        if (!eligible.length) {
            await this.saveQueueState(queueKey, [], 0);
            return null;
        }

        const eligibleIds = eligible.map((e) => e.userId);
        const state = await this.loadQueueState(queueKey);
        const turn = takeNextInQueue(state, eligibleIds, exclude);
        if (!turn) return null;

        await this.saveQueueState(queueKey, turn.state.orderedUserIds, turn.state.nextIndex);
        const broker = eligible.find((e) => e.userId === turn.chosenId);
        if (!broker) return null;

        const nextId = turn.state.orderedUserIds[turn.state.nextIndex];
        const queueSnapshot = JSON.stringify({
            order: turn.state.orderedUserIds,
            pickedName: broker.displayName,
            nextIndex: turn.state.nextIndex,
            nextName: eligible.find((e) => e.userId === nextId)?.displayName || null,
            excluded: exclude,
            names: turn.state.orderedUserIds.map(
                (id) => eligible.find((e) => e.userId === id)?.displayName || id
            ),
        });

        console.log(
            `[assignment] RR ${queueKey} → ${broker.displayName}; next → ${nextId}`
        );

        return { broker, queueSnapshot };
    }

    private async joinQueue(queueKey: string, userId: string) {
        const state = await this.loadQueueState(queueKey);
        if (state.orderedUserIds.includes(userId)) {
            return { ...state, joined: false };
        }
        const orderedUserIds = [...state.orderedUserIds, userId];
        await this.saveQueueState(queueKey, orderedUserIds, state.nextIndex);
        return { orderedUserIds, nextIndex: state.nextIndex, joined: true };
    }

    private async leaveQueue(queueKey: string, userId: string) {
        const state = await this.loadQueueState(queueKey);
        const idx = state.orderedUserIds.indexOf(userId);
        if (idx < 0) return null;
        const orderedUserIds = state.orderedUserIds.filter((id) => id !== userId);
        let nextIndex = state.nextIndex;
        if (orderedUserIds.length === 0) {
            nextIndex = 0;
        } else if (idx < state.nextIndex) {
            nextIndex = Math.max(0, state.nextIndex - 1);
        } else {
            nextIndex = state.nextIndex % orderedUserIds.length;
        }
        await this.saveQueueState(queueKey, orderedUserIds, nextIndex);
        return { orderedUserIds, nextIndex };
    }

    private async loadQueueState(
        queueKey = QUEUE_NEW
    ): Promise<{ orderedUserIds: string[]; nextIndex: number }> {
        const row = await prisma.assignmentQueueState.findUnique({
            where: { queueKey },
        });
        if (!row) return { orderedUserIds: [], nextIndex: 0 };
        let orderedUserIds: string[] = [];
        try {
            orderedUserIds = JSON.parse(row.orderedUserIdsJson || "[]");
            if (!Array.isArray(orderedUserIds)) orderedUserIds = [];
        } catch {
            orderedUserIds = [];
        }
        return { orderedUserIds, nextIndex: Math.max(0, row.nextIndex || 0) };
    }

    private async saveQueueState(queueKey: string, orderedUserIds: string[], nextIndex: number) {
        await prisma.assignmentQueueState.upsert({
            where: { queueKey },
            create: {
                queueKey,
                orderedUserIdsJson: JSON.stringify(orderedUserIds),
                nextIndex,
            },
            update: {
                orderedUserIdsJson: JSON.stringify(orderedUserIds),
                nextIndex,
            },
        });
    }

    private async pipelineLog(shipmentLeadId: string, message: string) {
        await shipmentImportLogRepository.create({
            eventType: "PipelineEvent",
            message,
            shipmentLeadId,
        });
    }

    private async assignmentLog(input: {
        shipmentLeadId?: string;
        assignedUserId?: string;
        assignedEmployeeId?: string;
        eventType: string;
        message: string;
        queueSnapshot?: string;
    }) {
        await prisma.assignmentLog.create({
            data: {
                shipmentLeadId: input.shipmentLeadId,
                assignedUserId: input.assignedUserId,
                assignedEmployeeId: input.assignedEmployeeId,
                eventType: input.eventType,
                message: input.message,
                queueSnapshotJson: input.queueSnapshot,
            },
        });
    }
}

export const assignmentEngine = new AssignmentEngine();
