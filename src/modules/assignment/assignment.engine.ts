import { prisma } from "../../config/database.js";
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
import { isLoadPhase, normalizeStatus } from "../shipment/shipment.lifecycle.js";

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

function isKeptByCurrentBroker(lead: { status: string; acceptedAt?: Date | null }) {
    if (lead.acceptedAt) return true;
    const status = normalizeStatus(lead.status);
    return KEPT_BY_BROKER.has(status) || isLoadPhase(status);
}

const QUEUE_KEY = "brokers";
/** Minutes to accept / react before load is passed to the next In Office broker. */
const ACCEPTANCE_MINUTES = 15;
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

export type AssignmentPoolMode = "in_office" | "all_brokers_fallback" | "none";

/**
 * Assignment Engine v1.0 — Round Robin driven only by Attendance:
 * In Office → in queue; Out of Office → removed immediately.
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

        const pick = await this.pickNextBrokerRoundRobin();
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
                "No eligible brokers (need active Broker + Attendance badge) — lead marked UNASSIGNED"
            );
            await this.assignmentLog({
                shipmentLeadId,
                eventType: "NO_ELIGIBLE",
                message: "No eligible brokers for assignment",
            });
            if (lead.status !== "UNASSIGNED") {
                await domainEventEngine.emit({
                    shipmentLeadId,
                    eventType: "SHIPMENT_UNASSIGNED",
                    title: "Unassigned",
                    message: "No eligible brokers for assignment",
                    timelineStage: "SHIPMENT_UNASSIGNED",
                });
            }
            try {
                sseEmitToRoles(["Owner", "Manager", "Administrator"], {
                    type: "SHIPMENT_UNASSIGNED",
                    shipmentLeadId,
                    shipmentTitle: lead.shipmentTitle,
                    reason: "No eligible brokers",
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

        const acceptanceDeadline = new Date(Date.now() + ACCEPTANCE_MINUTES * 60_000);
        const isReassignment = Boolean(
            options?.reassignFrom ||
                lead.wasEverReassigned ||
                lead.isReassignment ||
                lead.assignedBrokerId
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
            ? `Reassigned from ${options.reassignFrom} → ${broker.displayName} (no reaction in ${ACCEPTANCE_MINUTES}m)`
            : `Round-robin assigned to ${broker.displayName} (${broker.userId})`;

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
        for (const lead of expired) {
            const latest = await shipmentLeadRepository.findById(lead.shipmentLeadId);
            if (!latest || isKeptByCurrentBroker(latest)) continue;
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

            await this.pipelineLog(
                lead.shipmentLeadId,
                `No reaction from ${previousLabel} within ${ACCEPTANCE_MINUTES}m — reassigning`
            );
            await domainEventEngine.emit({
                shipmentLeadId: lead.shipmentLeadId,
                eventType: "STATUS_CHANGED",
                title: "Acceptance missed — reassigning",
                message: `${previousLabel} did not accept within ${ACCEPTANCE_MINUTES} minutes`,
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
                    message: `You did not accept shipment # ${gosId} within ${ACCEPTANCE_MINUTES} minutes — it was passed to the next broker`,
                    shipmentLeadId: lead.shipmentLeadId,
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

            const pick = await this.pickNextBrokerRoundRobin({
                excludeUserIds: [previousBrokerId],
            });

            if (!pick) {
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
        const synced = this.syncQueueOrder(
            state.orderedUserIds,
            eligible.map((e) => e.userId),
            state.nextIndex
        );
        const modeLabel =
            mode === "in_office"
                ? "Checked-in brokers only"
                : mode === "all_brokers_fallback"
                  ? "Nobody In Office — round-robin all brokers (Gary first)"
                  : "No eligible brokers";
        return {
            version: "1.0",
            algorithm: "round_robin_sequential",
            assignmentMode: mode,
            assignmentModeLabel: modeLabel,
            rules: [
                "NEW shipments go to checked-in (In Office) brokers only — sequential round-robin",
                "Fresh NEW imports are assigned before passed-along (reassigned) loads",
                "If nobody is In Office → all active brokers receive shipments in order (Gary first, then A→Z)",
                "When someone checks in → only checked-in brokers receive new shipments",
                "Waiting leads not accepted in 15 minutes go to the next broker — Open in uShip still passes; only Accept Shipment keeps the load",
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

    async listAssignmentLogs(limit = 100) {
        return prisma.assignmentLog.findMany({
            orderBy: { createdAt: "desc" },
            take: limit,
        });
    }

    /**
     * Attendance card ENTRY → In Office → join end of assignment queue.
     * Attendance card EXIT → Out of Office → leave queue immediately.
     */
    async onBrokerEnteredOffice(employeeId: string) {
        const user = await this.findBrokerUserByEmployeeId(employeeId);
        if (!user) return null;

        const state = await this.loadQueueState();
        let orderedUserIds = state.orderedUserIds;
        let nextIndex = state.nextIndex;

        if (!orderedUserIds.includes(user.userId)) {
            orderedUserIds = [...orderedUserIds, user.userId];
            await this.saveQueueState(orderedUserIds, nextIndex);
            await this.assignmentLog({
                assignedUserId: user.userId,
                assignedEmployeeId: employeeId,
                eventType: "QUEUE_JOIN",
                message: `${displayName(user)} In Office → added to assignment queue (position ${orderedUserIds.length})`,
                queueSnapshot: JSON.stringify({ order: orderedUserIds, nextIndex }),
            });
            console.log(
                `[assignment] QUEUE_JOIN ${displayName(user)} — queue size ${orderedUserIds.length}`
            );
        }

        // Spec: first broker back In Office → auto-assign pending Unassigned / NEW leads
        const drained = await this.assignPendingNewLeads(3);
        if (drained > 0) {
            console.log(
                `[assignment] drained ${drained} pending shipment(s) after ${displayName(user)} In Office`
            );
        }

        return { orderedUserIds, nextIndex };
    }

    /**
     * Assign waiting NEW / first-time UNASSIGNED shipments via Round Robin.
     * Automatic ticks never hand out old passed-along (Other) loads — those
     * only fill in after every fresh import is gone, and only when asked.
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
                },
                orderBy: { createdAt: "asc" },
                take: limit,
                select: { shipmentLeadId: true },
            }),
            prisma.shipmentLead.findMany({
                where: { ...unassignedPool, ...freshFilter },
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

        if (options?.includeOther && pending.length < limit) {
            const stillFresh = await prisma.shipmentLead.count({
                where: {
                    OR: [
                        {
                            status: "NEW",
                            OR: [{ assignedBrokerId: null }, { assignedBrokerId: "" }],
                        },
                        { ...unassignedPool, ...freshFilter },
                    ],
                },
            });
            if (stillFresh === 0) {
                const unassignedOther = await prisma.shipmentLead.findMany({
                    where: {
                        ...unassignedPool,
                        OR: [{ wasEverReassigned: true }, { isReassignment: true }],
                    },
                    orderBy: { createdAt: "asc" },
                    take: limit - pending.length,
                    select: { shipmentLeadId: true },
                });
                for (const row of unassignedOther) {
                    if (seen.has(row.shipmentLeadId)) continue;
                    seen.add(row.shipmentLeadId);
                    pending.push(row);
                }
            }
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
        return assigned;
    }

    async onBrokerLeftOffice(employeeId: string) {
        const user = await this.findBrokerUserByEmployeeId(employeeId);
        if (!user) return null;

        const state = await this.loadQueueState();
        const idx = state.orderedUserIds.indexOf(user.userId);
        if (idx < 0) return state;

        const orderedUserIds = state.orderedUserIds.filter((id) => id !== user.userId);
        let nextIndex = state.nextIndex;
        if (orderedUserIds.length === 0) {
            nextIndex = 0;
        } else if (idx < state.nextIndex) {
            nextIndex = Math.max(0, state.nextIndex - 1);
        } else if (idx === state.nextIndex) {
            // Was next — stay on same slot (now points to the following person)
            nextIndex = state.nextIndex % orderedUserIds.length;
        } else {
            nextIndex = state.nextIndex % orderedUserIds.length;
        }

        await this.saveQueueState(orderedUserIds, nextIndex);
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
                role: { roleName: { in: ["Broker", "Manager", "Owner"] } },
            },
            include: { role: true },
        });
        if (user) return user;

        const emp = await prisma.employee.findUnique({ where: { employeeId } });
        if (!emp) return null;

        const candidates = await prisma.user.findMany({
            where: { role: { roleName: { in: ["Broker", "Manager", "Owner"] } } },
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
     * Eligible brokers for round-robin:
     * 1) Prefer Brokers who are In Office (Attendance check-in).
     * 2) If nobody is In Office → all active Brokers with a badge (Gary first, then A→Z).
     * Gmail is NOT required. `availableForAssignment` is ignored.
     */
    async listEligibleBrokers(): Promise<EligibleBroker[]> {
        const { eligible } = await this.resolveEligibleBrokers();
        return eligible;
    }

    async resolveEligibleBrokers(): Promise<{
        eligible: EligibleBroker[];
        mode: AssignmentPoolMode;
    }> {
        const [users, activeEmployees] = await Promise.all([
            prisma.user.findMany({
                where: {
                    role: { roleName: "Broker" },
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

        for (const user of users) {
            const employeeId = this.resolveEmployeeIdSync(user, activeEmployees);
            if (!employeeId) continue;

            if (!user.employeeId) {
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
                employeeId,
                displayName: displayName(user),
            };
            allLinked.push(entry);
            employeeIdsToCheck.push(employeeId);
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
        const inOffice = allLinked.filter((entry) => inOfficeIds.has(entry.employeeId));

        if (inOffice.length > 0) {
            return {
                eligible: sortBrokersForRoundRobin(inOffice),
                mode: "in_office",
            };
        }
        if (allLinked.length > 0) {
            console.info(
                `[assignment] no broker In Office — falling back to round-robin across ${allLinked.length} broker(s), Gary first`
            );
            return {
                eligible: sortBrokersForRoundRobin(allLinked),
                mode: "all_brokers_fallback",
            };
        }
        return { eligible: [], mode: "none" };
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
        return null;
    }

    private async pickNextBrokerRoundRobin(options?: {
        excludeUserIds?: string[];
    }): Promise<{
        broker: EligibleBroker;
        queueSnapshot: string;
    } | null> {
        const exclude = new Set(options?.excludeUserIds || []);
        const eligible = await this.listEligibleBrokers();
        if (!eligible.length) {
            await this.saveQueueState([], 0);
            return null;
        }

        // Stable order by name so the rotating pointer is predictable; newcomers append via syncQueueOrder.
        const eligibleIds = eligible.map((e) => e.userId);
        const state = await this.loadQueueState();
        const synced = this.syncQueueOrder(state.orderedUserIds, eligibleIds, state.nextIndex);

        if (!synced.orderedUserIds.length) {
            await this.saveQueueState([], 0);
            return null;
        }

        const n = synced.orderedUserIds.length;
        // Walk from nextIndex: first In-Office broker not excluded = this shipment's assignee.
        for (let i = 0; i < n; i++) {
            const idx = (synced.nextIndex + i) % n;
            const chosenId = synced.orderedUserIds[idx];
            if (exclude.has(chosenId)) continue;
            const broker = eligible.find((e) => e.userId === chosenId);
            if (!broker) continue;

            // Advance pointer to the person AFTER the one we just assigned (strict sequential).
            const nextIndex = (idx + 1) % n;
            await this.saveQueueState(synced.orderedUserIds, nextIndex);

            const queueSnapshot = JSON.stringify({
                order: synced.orderedUserIds,
                pickedIndex: idx,
                pickedName: broker.displayName,
                nextIndex,
                nextName:
                    eligible.find((e) => e.userId === synced.orderedUserIds[nextIndex])
                        ?.displayName || null,
                excluded: [...exclude],
                names: synced.orderedUserIds.map(
                    (id) => eligible.find((e) => e.userId === id)?.displayName || id
                ),
            });

            console.log(
                `[assignment] RR → ${broker.displayName} (idx ${idx}/${n}); next → ${
                    synced.orderedUserIds[nextIndex]
                }`
            );

            return { broker, queueSnapshot };
        }

        return null;
    }

    /**
     * Remove ineligible; append newly eligible to the END (fair return-to-office).
     * Adjust nextIndex so we don't skip unfairly when removals happen before cursor.
     */
    syncQueueOrder(
        previousOrder: string[],
        eligibleIds: string[],
        previousNextIndex: number
    ): { orderedUserIds: string[]; nextIndex: number } {
        const eligibleSet = new Set(eligibleIds);
        const remaining = previousOrder.filter((id) => eligibleSet.has(id));
        const remainingSet = new Set(remaining);
        const newcomers = eligibleIds.filter((id) => !remainingSet.has(id));

        // Who was next before sync?
        const previousNextId =
            previousOrder.length > 0
                ? previousOrder[previousNextIndex % previousOrder.length]
                : null;

        const orderedUserIds = [...remaining, ...newcomers];

        let nextIndex = 0;
        if (orderedUserIds.length === 0) {
            nextIndex = 0;
        } else if (previousNextId && remainingSet.has(previousNextId)) {
            // Continue at the same person who was next (if still eligible)
            nextIndex = orderedUserIds.indexOf(previousNextId);
        } else if (previousNextId && previousOrder.length) {
            // Next person left — find the next still-eligible after their old position
            let found = false;
            for (let i = 1; i <= previousOrder.length; i++) {
                const cand = previousOrder[(previousNextIndex + i) % previousOrder.length];
                if (remainingSet.has(cand)) {
                    nextIndex = orderedUserIds.indexOf(cand);
                    found = true;
                    break;
                }
            }
            if (!found) nextIndex = 0;
        } else {
            nextIndex = 0;
        }

        return { orderedUserIds, nextIndex };
    }

    private async loadQueueState(): Promise<{ orderedUserIds: string[]; nextIndex: number }> {
        const row = await prisma.assignmentQueueState.findUnique({
            where: { queueKey: QUEUE_KEY },
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

    private async saveQueueState(orderedUserIds: string[], nextIndex: number) {
        await prisma.assignmentQueueState.upsert({
            where: { queueKey: QUEUE_KEY },
            create: {
                queueKey: QUEUE_KEY,
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
