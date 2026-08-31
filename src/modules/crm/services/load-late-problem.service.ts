import { prisma } from "../../../config/database.js";
import { getBrokerTeamLeadId } from "../../../auth/team-scope.js";
import { platformNotificationService } from "../../shipment/services/platform-notification.service.js";
import { sseEmitToUser, sseEmitToRoles } from "./realtime.hub.js";

/** Minutes past scheduled load/unload before Team Lead is notified. */
export const LOAD_LATE_GRACE_MINUTES = 15;

export type LoadLateKind = "PICKUP" | "DELIVERY";

const TERMINAL_STATUSES = [
    "COMPLETED",
    "CLOSED",
    "LOST",
    "DELETED_FROM_CUSTOMER",
    "CANCELLED",
];

/** Pickup considered done — no longer “late for loading”. */
const PICKUP_DONE_STATUSES = [
    "IN_TRANSIT",
    "PICKED_UP",
    "DELIVERED",
    "POD_UPLOADED",
    "CUSTOMER_INVOICE",
    "COMPLETED",
    "CLOSED",
];

/** Delivery considered done — no longer “late for unloading”. */
const DELIVERY_DONE_STATUSES = [
    "DELIVERED",
    "POD_UPLOADED",
    "CUSTOMER_INVOICE",
    "COMPLETED",
    "CLOSED",
];

const ACTIVE_LOAD_STATUSES = [
    "ACCEPTED",
    "BOOKED",
    "LOAD_CREATED",
    "DISPATCH",
    "CARRIER_ASSIGNED",
    "RATE_CON_GENERATED",
    "CARRIER_ACCEPTED",
    "PICKUP",
    "IN_TRANSIT",
    "PICKED_UP",
];

function displayName(u: {
    firstName?: string | null;
    lastName?: string | null;
    username?: string | null;
}): string {
    const n = `${u.firstName || ""} ${u.lastName || ""}`.trim();
    return n || u.username || "broker";
}

function kindLabel(kind: LoadLateKind): string {
    return kind === "PICKUP" ? "loading (pickup)" : "unloading (delivery)";
}

/**
 * Scan active loads: if scheduled pickup/delivery + 15m has passed
 * and the stage is not marked done → archive Late + notify Team Lead once.
 */
export async function processOverdueLoadLates(limit = 80): Promise<number> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - LOAD_LATE_GRACE_MINUTES * 60_000);

    const leads = await prisma.shipmentLead.findMany({
        where: {
            status: { notIn: TERMINAL_STATUSES },
            OR: [
                { loadNumber: { not: null } },
                { status: { in: ACTIVE_LOAD_STATUSES } },
            ],
            AND: [
                {
                    OR: [
                        { opsPickupAt: { lt: cutoff } },
                        { AND: [{ opsPickupAt: null }, { pickupFrom: { lt: cutoff } }] },
                        { opsDeliveryAt: { lt: cutoff } },
                        {
                            AND: [
                                { opsDeliveryAt: null },
                                { deliveryFrom: { lt: cutoff } },
                            ],
                        },
                    ],
                },
            ],
        },
        take: limit,
        orderBy: { updatedAt: "asc" },
        select: {
            shipmentLeadId: true,
            loadNumber: true,
            greenOsShipmentId: true,
            shipmentTitle: true,
            status: true,
            assignedBrokerId: true,
            opsPickupAt: true,
            pickupFrom: true,
            opsDeliveryAt: true,
            deliveryFrom: true,
        },
    });

    let archived = 0;
    for (const lead of leads) {
        try {
            const pickupAt = lead.opsPickupAt || lead.pickupFrom;
            if (
                pickupAt &&
                pickupAt.getTime() <= cutoff.getTime() &&
                !PICKUP_DONE_STATUSES.includes(lead.status)
            ) {
                if (await archiveLateIfNew(lead, "PICKUP", pickupAt, now)) archived += 1;
            }

            const deliveryAt = lead.opsDeliveryAt || lead.deliveryFrom;
            if (
                deliveryAt &&
                deliveryAt.getTime() <= cutoff.getTime() &&
                !DELIVERY_DONE_STATUSES.includes(lead.status)
            ) {
                if (await archiveLateIfNew(lead, "DELIVERY", deliveryAt, now)) archived += 1;
            }
        } catch (err) {
            console.warn(
                "[problems/late] archive failed",
                lead.shipmentLeadId,
                err instanceof Error ? err.message : err
            );
        }
    }
    return archived;
}

async function archiveLateIfNew(
    lead: {
        shipmentLeadId: string;
        loadNumber: string | null;
        greenOsShipmentId: string | null;
        shipmentTitle: string | null;
        status: string;
        assignedBrokerId: string | null;
    },
    lateKind: LoadLateKind,
    scheduledAt: Date,
    detectedAt: Date
): Promise<boolean> {
    const existing = await prisma.loadLateProblem.findUnique({
        where: {
            shipmentLeadId_lateKind: {
                shipmentLeadId: lead.shipmentLeadId,
                lateKind,
            },
        },
    });
    if (existing) return false;

    let brokerUserId: string | null = lead.assignedBrokerId;
    let brokerName = "—";
    let teamLeadId: string | null = null;
    let teamLeadName: string | null = null;

    if (brokerUserId) {
        const broker = await prisma.user.findUnique({
            where: { userId: brokerUserId },
            select: {
                userId: true,
                firstName: true,
                lastName: true,
                username: true,
                teamLeadId: true,
            },
        });
        if (broker) {
            brokerName = displayName(broker);
            teamLeadId =
                broker.teamLeadId || (await getBrokerTeamLeadId(broker.userId)) || null;
        }
    }

    if (teamLeadId) {
        const tl = await prisma.user.findUnique({
            where: { userId: teamLeadId },
            select: { firstName: true, lastName: true, username: true },
        });
        teamLeadName = tl ? displayName(tl) : null;
    }

    const graceDeadlineAt = new Date(
        scheduledAt.getTime() + LOAD_LATE_GRACE_MINUTES * 60_000
    );

    const problem = await prisma.loadLateProblem.create({
        data: {
            shipmentLeadId: lead.shipmentLeadId,
            lateKind,
            brokerUserId,
            brokerName,
            teamLeadUserId: teamLeadId,
            teamLeadName,
            scheduledAt,
            graceDeadlineAt,
            detectedAt,
            loadNumber: lead.loadNumber,
            greenOsShipmentId: lead.greenOsShipmentId,
            shipmentTitle: lead.shipmentTitle,
            loadStatus: lead.status,
            notifiedTeamLead: false,
            status: "OPEN",
        },
    });

    const ref =
        lead.loadNumber ||
        lead.greenOsShipmentId ||
        lead.shipmentLeadId.slice(0, 8);
    const title = `Late ${kindLabel(lateKind)}: ${ref}`;
    const message = `Load ${ref} — scheduled ${kindLabel(lateKind)} ${scheduledAt.toLocaleString()} was missed by ${LOAD_LATE_GRACE_MINUTES}+ minutes (broker: ${brokerName})`;

    if (teamLeadId) {
        await platformNotificationService
            .notifyUser({
                userId: teamLeadId,
                notificationType: "LOAD_LATE",
                title,
                message,
                shipmentLeadId: lead.shipmentLeadId,
                meta: {
                    problemId: problem.problemId,
                    lateKind,
                    loadNumber: lead.loadNumber,
                    brokerUserId,
                    brokerName,
                },
            })
            .catch(() => null);
        sseEmitToUser(teamLeadId, {
            type: "LOAD_LATE",
            problemId: problem.problemId,
            lateKind,
            shipmentLeadId: lead.shipmentLeadId,
            loadNumber: lead.loadNumber,
            greenOsShipmentId: lead.greenOsShipmentId,
            brokerName,
            message,
            at: detectedAt.toISOString(),
        });
        await prisma.loadLateProblem.update({
            where: { problemId: problem.problemId },
            data: { notifiedTeamLead: true },
        });
    }

    sseEmitToRoles(["Owner", "Manager", "Administrator"], {
        type: "LOAD_LATE",
        problemId: problem.problemId,
        lateKind,
        shipmentLeadId: lead.shipmentLeadId,
        loadNumber: lead.loadNumber,
        greenOsShipmentId: lead.greenOsShipmentId,
        brokerName,
        teamLeadName,
        message,
        at: detectedAt.toISOString(),
    });
    await platformNotificationService
        .notifyRoles({
            roles: ["Owner", "Manager", "Administrator"],
            notificationType: "LOAD_LATE",
            title,
            message,
            shipmentLeadId: lead.shipmentLeadId,
            meta: {
                problemId: problem.problemId,
                lateKind,
                brokerUserId,
                brokerName,
            },
        })
        .catch(() => null);

    console.log(
        `[problems/late] archived ${lateKind} ${ref} — ${brokerName} (TL: ${teamLeadName || "none"})`
    );
    return true;
}

export async function listLoadLateProblems(options?: {
    teamLeadId?: string | null;
    lateKind?: LoadLateKind | null;
    limit?: number;
}) {
    const where: Record<string, unknown> = {};
    if (options?.teamLeadId) {
        where.teamLeadUserId = options.teamLeadId;
    }
    if (options?.lateKind) {
        where.lateKind = options.lateKind;
    }
    return prisma.loadLateProblem.findMany({
        where,
        orderBy: { detectedAt: "desc" },
        take: options?.limit ?? 300,
    });
}
