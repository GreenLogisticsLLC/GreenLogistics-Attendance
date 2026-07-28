import { prisma } from "../../config/database.js";
import { attendanceSessionRepository } from "../../repositories/attendance-session.repository.js";
import { shipmentTimelineService } from "../crm/services/timeline.service.js";
import {
    shipmentImportLogRepository,
    shipmentLeadRepository,
} from "../email/services/repositories.js";
import type { ShipmentLeadStatus } from "../email/models/types.js";

const QUEUE_KEY = "brokers";
const ACCEPTANCE_MINUTES = 15;

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
            await shipmentTimelineService.addEvent({
                shipmentLeadId,
                stage: "IMPORTED",
                title: "Imported from uShip",
                message: lead.shipmentTitle,
            });
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
                "No broker In Office — lead marked UNASSIGNED"
            );
            await this.assignmentLog({
                shipmentLeadId,
                eventType: "NO_ELIGIBLE",
                message: "No broker currently In Office (Attendance)",
            });
            return parked || lead;
        }

        const { broker, queueSnapshot } = pick;
        const acceptanceDeadline = new Date(Date.now() + ACCEPTANCE_MINUTES * 60_000);

        const assigned = await shipmentLeadRepository.update(shipmentLeadId, {
            status: "ASSIGNED",
            assignedBrokerId: broker.userId,
            assignedAt: new Date(),
            acceptanceDeadline,
        });

        await this.pipelineLog(
            shipmentLeadId,
            `Round-robin assigned to ${broker.displayName} (${broker.userId})`
        );
        await shipmentTimelineService.addEvent({
            shipmentLeadId,
            stage: "ASSIGNED",
            title: `Assigned to ${broker.displayName}`,
            message: `Round Robin → ${broker.displayName}`,
            actorUserId: broker.userId,
        });
        await this.assignmentLog({
            shipmentLeadId,
            assignedUserId: broker.userId,
            assignedEmployeeId: broker.employeeId,
            eventType: "ASSIGNED",
            message: `Assigned to ${broker.displayName} via Round Robin`,
            queueSnapshot,
        });

        const awaiting = await shipmentLeadRepository.update(shipmentLeadId, {
            status: "AWAITING_ACCEPTANCE",
        });
        await this.pipelineLog(shipmentLeadId, "Status → AWAITING_ACCEPTANCE");
        return awaiting || assigned;
    }

    async processDueAcceptances() {
        const now = new Date();
        const expired = await prisma.shipmentLead.findMany({
            where: {
                status: "AWAITING_ACCEPTANCE",
                acceptanceDeadline: { lt: now },
            },
            take: 50,
        });

        for (const lead of expired) {
            await shipmentLeadRepository.update(lead.shipmentLeadId, {
                status: "FOLLOW_UP",
            });
            await this.pipelineLog(lead.shipmentLeadId, "Acceptance timer expired → FOLLOW_UP");
            await shipmentTimelineService.addEvent({
                shipmentLeadId: lead.shipmentLeadId,
                stage: "ASSIGNED",
                title: "Needs Follow Up",
                message: "Acceptance timer expired",
            });
        }
        return expired.length;
    }

    async markQuoteSent(shipmentLeadId: string) {
        const updated = await shipmentLeadRepository.update(shipmentLeadId, {
            status: "QUOTE_SENT" satisfies ShipmentLeadStatus,
            quoteSentAt: new Date(),
        });
        await this.pipelineLog(shipmentLeadId, "Status → QUOTE_SENT");
        await shipmentTimelineService.addEvent({
            shipmentLeadId,
            stage: "QUOTE_SENT",
            title: "Quote Sent",
        });
        return updated;
    }

    async closeLead(shipmentLeadId: string, outcome: "WON" | "LOST") {
        const updated = await shipmentLeadRepository.update(shipmentLeadId, {
            status: outcome,
            closedAt: new Date(),
        });
        await this.pipelineLog(shipmentLeadId, `Status → ${outcome}`);
        await shipmentTimelineService.addEvent({
            shipmentLeadId,
            stage: "COMPLETED",
            title: outcome === "WON" ? "Won" : "Lost",
        });
        return updated;
    }

    /** Public snapshot for managers / debugging. */
    async getQueueStatus() {
        const eligible = await this.listEligibleBrokers();
        const state = await this.loadQueueState();
        const synced = this.syncQueueOrder(
            state.orderedUserIds,
            eligible.map((e) => e.userId),
            state.nextIndex
        );
        return {
            version: "1.0",
            algorithm: "round_robin",
            rules: ["Attendance card only: In Office joins queue, Out of Office leaves queue"],
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
        const drained = await this.assignPendingNewLeads(20);
        if (drained > 0) {
            console.log(
                `[assignment] drained ${drained} pending shipment(s) after ${displayName(user)} In Office`
            );
        }

        return { orderedUserIds, nextIndex };
    }

    /**
     * Assign waiting NEW / UNASSIGNED shipments (no broker) via Round Robin.
     * Called when a broker returns In Office, or manually from ops tools.
     */
    async assignPendingNewLeads(limit = 50): Promise<number> {
        const pending = await prisma.shipmentLead.findMany({
            where: {
                status: { in: ["NEW", "UNASSIGNED"] },
                OR: [{ assignedBrokerId: null }, { assignedBrokerId: "" }],
            },
            orderBy: { createdAt: "asc" },
            take: limit,
            select: { shipmentLeadId: true },
        });

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
     * Eligible = linked broker whose Attendance status is In Office.
     * Out of Office → excluded. Queue order is driven by card swipes (arrival order).
     */
    async listEligibleBrokers(): Promise<EligibleBroker[]> {
        const users = await prisma.user.findMany({
            where: {
                role: { roleName: { in: ["Broker", "Manager", "Owner"] } },
            },
            include: { role: true, employee: true },
            orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
        });

        const preferred = users.filter((u) => u.role.roleName === "Broker");
        const pool = preferred.length ? preferred : users;

        const eligible: EligibleBroker[] = [];
        for (const user of pool) {
            const employeeId = await this.resolveEmployeeId(user);
            if (!employeeId) continue;

            const session = await attendanceSessionRepository.findRecentActiveSession(employeeId);
            // Only In Office participates; Out of Office / other statuses are excluded.
            if (!session || session.currentStatus !== "INSIDE_OFFICE") continue;

            if (!user.employeeId) {
                try {
                    await prisma.user.update({
                        where: { userId: user.userId },
                        data: { employeeId },
                    });
                } catch {
                    /* unique conflict — ignore */
                }
            }

            eligible.push({
                userId: user.userId,
                username: user.username,
                firstName: user.firstName,
                lastName: user.lastName,
                employeeId,
                displayName: displayName(user),
            });
        }
        return eligible;
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

    private async pickNextBrokerRoundRobin(): Promise<{
        broker: EligibleBroker;
        queueSnapshot: string;
    } | null> {
        // Rebuild from Attendance first, then sync persisted arrival-order queue.
        const eligible = await this.listEligibleBrokers();
        if (!eligible.length) {
            await this.saveQueueState([], 0);
            return null;
        }

        const eligibleIds = eligible.map((e) => e.userId);
        const state = await this.loadQueueState();
        // Keep arrival order; drop anyone no longer In Office; append any In Office missing from queue.
        const synced = this.syncQueueOrder(state.orderedUserIds, eligibleIds, state.nextIndex);
        await this.saveQueueState(synced.orderedUserIds, synced.nextIndex);

        if (!synced.orderedUserIds.length) return null;

        const idx = synced.nextIndex % synced.orderedUserIds.length;
        const chosenId = synced.orderedUserIds[idx];
        const broker = eligible.find((e) => e.userId === chosenId);
        if (!broker) return null;

        const nextIndex = (idx + 1) % synced.orderedUserIds.length;
        await this.saveQueueState(synced.orderedUserIds, nextIndex);

        const queueSnapshot = JSON.stringify({
            order: synced.orderedUserIds,
            pickedIndex: idx,
            nextIndex,
            names: synced.orderedUserIds.map(
                (id) => eligible.find((e) => e.userId === id)?.displayName || id
            ),
        });

        return { broker, queueSnapshot };
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
