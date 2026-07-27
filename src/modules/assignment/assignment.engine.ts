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
        if (!lead || lead.status !== "NEW") return lead;

        await shipmentTimelineService.addEvent({
            shipmentLeadId,
            stage: "IMPORTED",
            title: "Imported from uShip",
            message: lead.shipmentTitle,
        });

        const pick = await this.pickNextBrokerRoundRobin();
        if (!pick) {
            await this.pipelineLog(shipmentLeadId, "No broker In Office — lead stays NEW");
            await this.assignmentLog({
                shipmentLeadId,
                eventType: "NO_ELIGIBLE",
                message: "No broker currently In Office (Attendance)",
            });
            return lead;
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
            rules: ["Attendance In Office only"],
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
     * Eligible = linked broker whose Attendance status is In Office.
     * Out of Office (or no session) → excluded from the queue immediately.
     * No manual Active / Available toggles are used.
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
        const eligible = await this.listEligibleBrokers();
        if (!eligible.length) return null;

        const eligibleIds = eligible.map((e) => e.userId);
        const state = await this.loadQueueState();
        const synced = this.syncQueueOrder(state.orderedUserIds, eligibleIds, state.nextIndex);

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
