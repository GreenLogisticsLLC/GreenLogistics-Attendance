import { prisma } from "../../../config/database.js";
import { getBrokerTeamLeadId } from "../../../auth/team-scope.js";
import { platformNotificationService } from "../../shipment/services/platform-notification.service.js";
import { sseEmitToUser, sseEmitToRoles } from "./realtime.hub.js";

/** Minutes after Customer Respond before broker Answer is required. */
export const BROKER_REPLY_MINUTES = 10;

const CUSTOMER_EVENT_TYPES = [
    "CUSTOMER_RESPOND",
    "CUSTOMER_REPLIED",
    "CUSTOMER_QUESTION",
    "NEW_MESSAGE",
];
const BROKER_ANSWER_TYPES = ["BROKER_QUESTION", "BROKER_ANSWER"];

function displayName(u: {
    firstName?: string | null;
    lastName?: string | null;
    username?: string | null;
}): string {
    const n = `${u.firstName || ""} ${u.lastName || ""}`.trim();
    return n || u.username || "broker";
}

export async function armBrokerReplyDeadline(
    shipmentLeadId: string,
    from: Date = new Date()
): Promise<Date> {
    const deadline = new Date(from.getTime() + BROKER_REPLY_MINUTES * 60_000);
    await prisma.shipmentLead.update({
        where: { shipmentLeadId },
        data: { brokerReplyDeadline: deadline },
    });
    return deadline;
}

export async function clearBrokerReplyDeadline(shipmentLeadId: string): Promise<void> {
    await prisma.shipmentLead
        .update({
            where: { shipmentLeadId },
            data: { brokerReplyDeadline: null },
        })
        .catch(() => null);
}

/**
 * Archive Customer Respond episodes where the broker did not Answer in time.
 * Notifies the broker's Team Lead once per episode.
 */
export async function processOverdueBrokerReplies(limit = 40): Promise<number> {
    const now = new Date();
    const due = await prisma.shipmentLead.findMany({
        where: {
            brokerReplyDeadline: { lt: now, not: null },
            assignedBrokerId: { not: null },
            status: { in: ["CUSTOMER_REPLIED", "FOLLOW_UP", "WORKING", "BID_SUBMITTED"] },
        },
        take: limit,
        orderBy: { brokerReplyDeadline: "asc" },
    });

    let archived = 0;
    for (const lead of due) {
        try {
            const ok = await archiveIfStillUnanswered(lead.shipmentLeadId);
            if (ok) archived += 1;
        } catch (err) {
            console.warn(
                "[problems] archive failed",
                lead.shipmentLeadId,
                err instanceof Error ? err.message : err
            );
        }
    }
    return archived;
}

async function archiveIfStillUnanswered(shipmentLeadId: string): Promise<boolean> {
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId },
    });
    if (!lead?.assignedBrokerId || !lead.brokerReplyDeadline) return false;

    const customerEvent = await prisma.domainEvent.findFirst({
        where: {
            shipmentLeadId,
            eventType: { in: CUSTOMER_EVENT_TYPES },
        },
        orderBy: { createdAt: "desc" },
    });
    if (!customerEvent) {
        await clearBrokerReplyDeadline(shipmentLeadId);
        return false;
    }

    const brokerAnswer = await prisma.domainEvent.findFirst({
        where: {
            shipmentLeadId,
            eventType: { in: BROKER_ANSWER_TYPES },
            createdAt: { gt: customerEvent.createdAt },
        },
        orderBy: { createdAt: "asc" },
    });
    if (brokerAnswer) {
        await clearBrokerReplyDeadline(shipmentLeadId);
        return false;
    }

    const broker = await prisma.user.findUnique({
        where: { userId: lead.assignedBrokerId },
        select: {
            userId: true,
            firstName: true,
            lastName: true,
            username: true,
            teamLeadId: true,
        },
    });
    if (!broker) {
        await clearBrokerReplyDeadline(shipmentLeadId);
        return false;
    }

    const teamLeadId =
        broker.teamLeadId || (await getBrokerTeamLeadId(broker.userId)) || null;
    let teamLeadName: string | null = null;
    if (teamLeadId) {
        const tl = await prisma.user.findUnique({
            where: { userId: teamLeadId },
            select: { firstName: true, lastName: true, username: true },
        });
        teamLeadName = tl ? displayName(tl) : null;
    }

    const brokerName = displayName(broker);
    const eventKey = customerEvent.eventId;
    const existing = await prisma.brokerResponseProblem.findFirst({
        where: {
            shipmentLeadId,
            OR: [
                { customerRespondEventId: eventKey },
                { customerRespondEventId: null, brokerUserId: broker.userId },
            ],
        },
    });
    if (existing) {
        await clearBrokerReplyDeadline(shipmentLeadId);
        return false;
    }

    const deadlineAt = lead.brokerReplyDeadline;
    const problem = await prisma.brokerResponseProblem.create({
        data: {
            shipmentLeadId,
            brokerUserId: broker.userId,
            brokerName,
            teamLeadUserId: teamLeadId,
            teamLeadName,
            customerRespondAt: customerEvent.createdAt,
            deadlineAt,
            customerRespondEventId: eventKey,
            greenOsShipmentId: lead.greenOsShipmentId,
            shipmentTitle: lead.shipmentTitle,
            notifiedTeamLead: false,
            status: "OPEN",
        },
    });

    const gos = lead.greenOsShipmentId || shipmentLeadId.slice(0, 8);
    const title = "Problem: no Broker Answer after Customer Respond";
    const message = `${brokerName} did not answer Customer Respond on shipment # ${gos} within ${BROKER_REPLY_MINUTES} minutes`;

    if (teamLeadId) {
        await platformNotificationService
            .notifyUser({
                userId: teamLeadId,
                notificationType: "BROKER_RESPONSE_TIMEOUT",
                title,
                message,
                shipmentLeadId,
                meta: {
                    problemId: problem.problemId,
                    brokerUserId: broker.userId,
                    brokerName,
                    greenOsShipmentId: lead.greenOsShipmentId,
                },
            })
            .catch(() => null);
        sseEmitToUser(teamLeadId, {
            type: "BROKER_RESPONSE_TIMEOUT",
            problemId: problem.problemId,
            shipmentLeadId,
            greenOsShipmentId: lead.greenOsShipmentId,
            brokerName,
            message,
            at: new Date().toISOString(),
        });
        await prisma.brokerResponseProblem.update({
            where: { problemId: problem.problemId },
            data: { notifiedTeamLead: true },
        });
    }

    sseEmitToRoles(["Owner", "Manager", "Administrator"], {
        type: "BROKER_RESPONSE_TIMEOUT",
        problemId: problem.problemId,
        shipmentLeadId,
        greenOsShipmentId: lead.greenOsShipmentId,
        brokerName,
        teamLeadName,
        message,
        at: new Date().toISOString(),
    });
    await platformNotificationService
        .notifyRoles({
            roles: ["Owner", "Manager", "Administrator"],
            notificationType: "BROKER_RESPONSE_TIMEOUT",
            title,
            message,
            shipmentLeadId,
            meta: {
                problemId: problem.problemId,
                brokerUserId: broker.userId,
                brokerName,
            },
        })
        .catch(() => null);

    await clearBrokerReplyDeadline(shipmentLeadId);
    console.log(`[problems] archived ${gos} — ${brokerName} (TL: ${teamLeadName || "none"})`);
    return true;
}

export async function listBrokerResponseProblems(options?: {
    teamLeadId?: string | null;
    from?: Date | null;
    to?: Date | null;
    limit?: number;
}) {
    const where: Record<string, unknown> = {};
    if (options?.teamLeadId) {
        where.teamLeadUserId = options.teamLeadId;
    }
    if (options?.from || options?.to) {
        where.detectedAt = {
            ...(options.from ? { gte: options.from } : {}),
            ...(options.to ? { lt: options.to } : {}),
        };
    }
    return prisma.brokerResponseProblem.findMany({
        where,
        orderBy: { detectedAt: "desc" },
        take: options?.limit ?? 200,
    });
}

export async function monthlyBrokerResponseStats(options?: {
    teamLeadId?: string | null;
    year?: number;
    month?: number; // 1-12
}) {
    const now = new Date();
    const year = options?.year ?? now.getUTCFullYear();
    const month = options?.month ?? now.getUTCMonth() + 1;
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 1));

    const rows = await listBrokerResponseProblems({
        teamLeadId: options?.teamLeadId,
        from,
        to,
        limit: 5000,
    });

    const byBroker = new Map<
        string,
        { brokerUserId: string; brokerName: string; missCount: number }
    >();
    let teamLeadReminders = 0;
    for (const r of rows) {
        const cur = byBroker.get(r.brokerUserId) || {
            brokerUserId: r.brokerUserId,
            brokerName: r.brokerName,
            missCount: 0,
        };
        cur.missCount += 1;
        byBroker.set(r.brokerUserId, cur);
        if (r.notifiedTeamLead) teamLeadReminders += 1;
    }

    return {
        year,
        month,
        from: from.toISOString(),
        to: to.toISOString(),
        totalProblems: rows.length,
        teamLeadReminders,
        brokers: [...byBroker.values()].sort((a, b) => b.missCount - a.missCount),
        recent: rows.slice(0, 100).map((r) => ({
            problemId: r.problemId,
            shipmentLeadId: r.shipmentLeadId,
            greenOsShipmentId: r.greenOsShipmentId,
            shipmentTitle: r.shipmentTitle,
            brokerName: r.brokerName,
            brokerUserId: r.brokerUserId,
            teamLeadName: r.teamLeadName,
            customerRespondAt: r.customerRespondAt,
            detectedAt: r.detectedAt,
            notifiedTeamLead: r.notifiedTeamLead,
        })),
    };
}
