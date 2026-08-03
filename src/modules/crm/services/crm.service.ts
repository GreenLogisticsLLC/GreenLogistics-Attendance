import { prisma } from "../../../config/database.js";
import { config } from "../../../config/env.js";
import { attendanceSessionRepository } from "../../../repositories/attendance-session.repository.js";
import { ACTIVE_STATUSES } from "../crm.constants.js";
import { domainEventEngine } from "../../shipment/services/domain-event.engine.js";
import { shipmentService } from "../../shipment/services/shipment.service.js";
import { ensureGreenOsShipmentId } from "../../shipment/shipment.id.js";
import { statusLabel } from "../../shipment/shipment.lifecycle.js";
import { listTeamBrokerIds } from "../../../auth/team-scope.js";

function startOfToday(timezone: string): Date {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    // Approximate midnight local as UTC date string — good enough for KPI buckets
    return new Date(`${y}-${m}-${d}T00:00:00`);
}

function place(city?: string | null, state?: string | null, zip?: string | null) {
    return [city, state, zip].filter(Boolean).join(", ") || "—";
}

function brokerName(u: { firstName: string; lastName: string; username: string } | null | undefined) {
    if (!u) return "Unassigned";
    const n = `${u.firstName || ""} ${u.lastName || ""}`.trim();
    return n || u.username;
}

type BrokerUser = {
    userId: string;
    firstName: string;
    lastName: string;
    username: string;
    isActive: boolean;
};

async function userMap(ids: string[]): Promise<Map<string, BrokerUser>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const users = await prisma.user.findMany({
        where: { userId: { in: unique } },
        select: { userId: true, firstName: true, lastName: true, username: true, isActive: true },
    });
    return new Map(users.map((u: BrokerUser) => [u.userId, u]));
}

function enrichLead(lead: Record<string, unknown>, brokers: Map<string, BrokerUser>) {
    const brokerId = lead.assignedBrokerId as string | null;
    const broker = brokerId ? brokers.get(brokerId) : undefined;
    return {
        ...lead,
        customer: (lead.customerName as string) || "—",
        brokerName: brokerName(broker),
        brokerOnline: broker ? broker.isActive : false,
        pickup: place(lead.pickupCity as string, lead.pickupState as string, lead.pickupZip as string),
        delivery: place(lead.deliveryCity as string, lead.deliveryState as string, lead.deliveryZip as string),
        equipment: (lead.equipment as string) || (lead.category as string) || "—",
        vehicle: (lead.vehicle as string) || (lead.category as string) || "—",
        statusLabel: statusLabel(String(lead.status || "")),
        greenOsShipmentId: (lead.greenOsShipmentId as string) || null,
        loadNumber: (lead.loadNumber as string) || null,
        carrierName: (lead.carrierName as string) || null,
        driverName: (lead.driverName as string) || null,
        truckNumber: (lead.truckNumber as string) || null,
        trailerNumber: (lead.trailerNumber as string) || null,
        rateConfirmation: (lead.rateConfirmation as string) || null,
        podUrl: (lead.podUrl as string) || null,
        invoiceNumber: (lead.invoiceNumber as string) || null,
        paymentStatus: (lead.paymentStatus as string) || null,
        opsPickupAt: lead.opsPickupAt || null,
        opsDeliveryAt: lead.opsDeliveryAt || null,
        ushipUrl: lead.viewUrl || null,
    };
}

export class CrmService {
    async getDashboard(options?: { teamLeadId?: string }) {
        const todayStart = startOfToday(config.timezone);
        const teamBrokerIds = options?.teamLeadId
            ? await listTeamBrokerIds(options.teamLeadId)
            : null;
        const teamAssigned =
            teamBrokerIds != null
                ? { assignedBrokerId: { in: teamBrokerIds } }
                : {};
        const unassignedWhere = {
            status: { in: ["NEW", "UNASSIGNED"] },
            OR: [{ assignedBrokerId: null }, { assignedBrokerId: "" }],
        };

        const [
            newToday,
            unassignedCount,
            awaiting,
            working,
            quotesSent,
            won,
            lost,
            active,
            brokers,
            unassignedRows,
        ] = await Promise.all([
            prisma.shipmentLead.count({
                where: {
                    createdAt: { gte: todayStart },
                    ...(teamBrokerIds
                        ? {
                              OR: [
                                  { assignedBrokerId: { in: teamBrokerIds } },
                                  unassignedWhere,
                              ],
                          }
                        : {}),
                },
            }),
            prisma.shipmentLead.count({ where: unassignedWhere }),
            prisma.shipmentLead.count({
                where: { status: "AWAITING_ACCEPTANCE", ...teamAssigned },
            }),
            prisma.shipmentLead.count({
                where: { status: "WORKING", ...teamAssigned },
            }),
            prisma.shipmentLead.count({
                where: { status: "QUOTE_SENT", ...teamAssigned },
            }),
            prisma.shipmentLead.count({
                where: { status: "WON", ...teamAssigned },
            }),
            prisma.shipmentLead.count({
                where: { status: "LOST", ...teamAssigned },
            }),
            prisma.shipmentLead.count({
                where: { status: { in: [...ACTIVE_STATUSES] }, ...teamAssigned },
            }),
            this.getBrokerWorkload(options?.teamLeadId ? { teamLeadId: options.teamLeadId } : undefined),
            prisma.shipmentLead.findMany({
                where: unassignedWhere,
                orderBy: { createdAt: "asc" },
                take: 50,
            }),
        ]);

        const avgResponseMs = await this.averageResponseTimeMs(teamBrokerIds || undefined);
        const brokersById = await userMap([]);

        return {
            version: "1.0",
            scope: options?.teamLeadId ? "team" : "company",
            teamBrokerCount: teamBrokerIds?.length ?? null,
            kpis: {
                newShipmentsToday: newToday,
                unassigned: unassignedCount,
                awaitingAcceptance: awaiting,
                working,
                quotesSent,
                won,
                lost,
                activeShipments: active,
                averageResponseTimeMinutes: avgResponseMs == null ? null : Math.round(avgResponseMs / 60000),
            },
            unassignedShipments: unassignedRows.map((row) =>
                enrichLead(row as unknown as Record<string, unknown>, brokersById)
            ),
            brokerWorkload: brokers.map((b) => ({
                brokerId: b.brokerId,
                name: b.name,
                activeShipments: b.currentShipments,
            })),
        };
    }

    private async averageResponseTimeMs(teamBrokerIds?: string[]): Promise<number | null> {
        const rows = await prisma.shipmentLead.findMany({
            where: {
                assignedAt: { not: null },
                acceptedAt: { not: null },
                ...(teamBrokerIds ? { assignedBrokerId: { in: teamBrokerIds } } : {}),
            },
            select: { assignedAt: true, acceptedAt: true },
            take: 500,
            orderBy: { acceptedAt: "desc" },
        });
        const diffs = rows
            .filter((r) => r.assignedAt && r.acceptedAt)
            .map((r) => r.acceptedAt!.getTime() - r.assignedAt!.getTime())
            .filter((ms) => ms >= 0);
        if (!diffs.length) return null;
        return diffs.reduce((a, b) => a + b, 0) / diffs.length;
    }

    async listShipments(options?: {
        brokerId?: string;
        status?: string;
        limit?: number;
        teamLeadId?: string;
    }) {
        const where: Record<string, unknown> = {};
        if (options?.brokerId) {
            where.assignedBrokerId = options.brokerId;
        } else if (options?.teamLeadId) {
            const teamBrokerIds = await listTeamBrokerIds(options.teamLeadId);
            where.OR = [
                { assignedBrokerId: { in: teamBrokerIds } },
                {
                    status: { in: ["NEW", "UNASSIGNED"] },
                    OR: [{ assignedBrokerId: null }, { assignedBrokerId: "" }],
                },
            ];
        }
        if (options?.status) where.status = options.status;

        const rows = await prisma.shipmentLead.findMany({
            where,
            orderBy: { updatedAt: "desc" },
            take: options?.limit ?? 300,
        });
        const brokers = await userMap(rows.map((r) => r.assignedBrokerId || ""));
        return rows.map((r) => enrichLead(r as unknown as Record<string, unknown>, brokers));
    }

    async getShipmentCard(id: string) {
        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: id },
            include: {
                emailMessage: true,
                timelineEvents: { orderBy: { createdAt: "asc" } },
                importLogs: { orderBy: { createdAt: "desc" }, take: 50 },
                domainEvents: { orderBy: { createdAt: "asc" } },
            },
        });
        if (!lead) return null;

        await ensureGreenOsShipmentId(lead.shipmentLeadId).catch(() => null);
        const refreshedId = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: id },
            select: { greenOsShipmentId: true },
        });

        const brokers = await userMap(lead.assignedBrokerId ? [lead.assignedBrokerId] : []);
        const enriched = enrichLead(
            {
                ...(lead as unknown as Record<string, unknown>),
                greenOsShipmentId: refreshedId?.greenOsShipmentId || lead.greenOsShipmentId,
            },
            brokers
        );

        const pipeline = await domainEventEngine.buildLifecyclePipeline(lead.shipmentLeadId);

        let documents: unknown[] = [];
        try {
            documents = lead.documentsJson ? JSON.parse(lead.documentsJson) : [];
        } catch {
            documents = [];
        }

        const mailboxEmails = await prisma.brokerMailboxMessage.findMany({
            where: { shipmentLeadId: lead.shipmentLeadId },
            orderBy: { receivedAt: "asc" },
            take: 80,
            select: {
                messageId: true,
                subject: true,
                fromAddress: true,
                snippet: true,
                receivedAt: true,
                matchMethod: true,
                userId: true,
            },
        });

        return {
            ...enriched,
            documents,
            timeline: lead.timelineEvents,
            domainEvents: lead.domainEvents,
            pipeline,
            mailboxEmails,
            email: lead.emailMessage
                ? {
                      subject: lead.emailMessage.subject,
                      from: lead.emailMessage.fromAddress,
                      receivedAt: lead.emailMessage.receivedAt,
                  }
                : null,
        };
    }

    async getBrokerWorkload(options?: { teamLeadId?: string }) {
        const brokers = await prisma.user.findMany({
            where: {
                isActive: true,
                role: { roleName: { in: ["Broker", "Manager", "Owner"] } },
                ...(options?.teamLeadId ? { teamLeadId: options.teamLeadId } : {}),
            },
            include: {
                role: true,
                teamLead: { select: { userId: true, firstName: true, lastName: true, username: true } },
            },
            orderBy: { firstName: "asc" },
        });
        const preferred = brokers.filter((b) => b.role.roleName === "Broker");
        const pool = preferred.length ? preferred : brokers;

        const result: Array<{
            brokerId: string;
            name: string;
            username: string;
            role: string;
            status: string;
            online: boolean;
            active: boolean;
            availableForAssignment: boolean;
            inOffice: boolean;
            employeeId: string | null;
            teamLeadId: string | null;
            teamLeadName: string | null;
            currentShipments: number;
            awaitingAcceptance: number;
            followUp: number;
            quotesSent: number;
            won: number;
            lost: number;
            averageResponseTimeMinutes: number | null;
        }> = [];
        for (const b of pool) {
            const [currentShipments, awaitingAcceptance, followUp, quotesSent, won, lost] =
                await Promise.all([
                    prisma.shipmentLead.count({
                        where: { assignedBrokerId: b.userId, status: { in: [...ACTIVE_STATUSES] } },
                    }),
                    prisma.shipmentLead.count({
                        where: { assignedBrokerId: b.userId, status: "AWAITING_ACCEPTANCE" },
                    }),
                    prisma.shipmentLead.count({
                        where: { assignedBrokerId: b.userId, status: "FOLLOW_UP" },
                    }),
                    prisma.shipmentLead.count({
                        where: { assignedBrokerId: b.userId, status: "QUOTE_SENT" },
                    }),
                    prisma.shipmentLead.count({
                        where: { assignedBrokerId: b.userId, status: "WON" },
                    }),
                    prisma.shipmentLead.count({
                        where: { assignedBrokerId: b.userId, status: "LOST" },
                    }),
                ]);

            const accepted = await prisma.shipmentLead.findMany({
                where: {
                    assignedBrokerId: b.userId,
                    assignedAt: { not: null },
                    acceptedAt: { not: null },
                },
                select: { assignedAt: true, acceptedAt: true },
                take: 100,
            });
            const diffs = accepted
                .map((r) => r.acceptedAt!.getTime() - r.assignedAt!.getTime())
                .filter((ms) => ms >= 0);
            const avgMs = diffs.length ? diffs.reduce((a, c) => a + c, 0) / diffs.length : null;

            let inOffice = false;
            if (b.employeeId) {
                const session = await attendanceSessionRepository.findRecentActiveSession(
                    b.employeeId
                );
                inOffice = session?.currentStatus === "INSIDE_OFFICE";
            }

            const tl = b.teamLead;
            result.push({
                brokerId: b.userId,
                name: brokerName(b),
                username: b.username,
                role: b.role.roleName,
                status: b.isActive ? "Active" : "Inactive",
                online: b.isActive,
                active: b.isActive,
                availableForAssignment: b.availableForAssignment,
                inOffice,
                employeeId: b.employeeId,
                teamLeadId: b.teamLeadId || null,
                teamLeadName: tl ? brokerName(tl) : null,
                currentShipments,
                awaitingAcceptance,
                followUp,
                quotesSent,
                won,
                lost,
                averageResponseTimeMinutes: avgMs == null ? null : Math.round(avgMs / 60000),
            });
        }
        return result.sort((a, b) => b.currentShipments - a.currentShipments);
    }

    async getBrokerWorkspace(brokerId: string) {
        const user = await prisma.user.findUnique({
            where: { userId: brokerId },
            include: {
                role: true,
                teamLead: { select: { userId: true, firstName: true, lastName: true, username: true } },
            },
        });
        if (!user) return null;

        const stats = (await this.getBrokerWorkload()).find((b) => b.brokerId === brokerId);
        const shipments = await this.listShipments({ brokerId, limit: 200 });

        return {
            broker: {
                brokerId: user.userId,
                name: brokerName(user),
                username: user.username,
                role: user.role.roleName,
                online: user.isActive,
                teamLeadId: user.teamLeadId || null,
                teamLeadName: user.teamLead ? brokerName(user.teamLead) : null,
            },
            stats: stats || {
                currentShipments: 0,
                awaitingAcceptance: 0,
                followUp: 0,
                quotesSent: 0,
                won: 0,
                lost: 0,
            },
            shipments,
        };
    }

    async updateShipmentStatus(
        shipmentLeadId: string,
        status: string,
        actorUserId?: string,
        extras?: { notes?: string; price?: number; priority?: string; loadNumber?: string }
    ) {
        await shipmentService.transitionStatus({
            shipmentLeadId,
            status,
            actorUserId,
            extras,
            // Manual CRM saves may jump stages; Event Engine still records the change.
            skipLifecycleCheck: true,
        });
        return this.getShipmentCard(shipmentLeadId);
    }

    /** First open by the assigned broker: Awaiting Agent → Agent Open (idempotent). */
    async markAgentOpened(shipmentLeadId: string, actorUserId: string) {
        const result = await prisma.shipmentLead.updateMany({
            where: {
                shipmentLeadId,
                assignedBrokerId: actorUserId,
                status: { in: ["ASSIGNED", "AWAITING_ACCEPTANCE"] },
            },
            data: { status: "AGENT_OPEN" },
        });

        if (result.count > 0) {
            await domainEventEngine.emit({
                shipmentLeadId,
                eventType: "AGENT_OPENED",
                title: "Agent Opened Shipment",
                message: "Status → Agent Open",
                actorUserId,
                timelineStage: "AGENT_OPENED",
                payload: { status: "AGENT_OPEN" },
            });
        }

        return this.getShipmentCard(shipmentLeadId);
    }

    async acceptShipment(shipmentLeadId: string, actorUserId: string) {
        const lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!lead) return null;
        if (lead.assignedBrokerId && lead.assignedBrokerId !== actorUserId) {
            throw Object.assign(new Error("Only the assigned broker can accept this shipment"), {
                status: 403,
            });
        }
        if (
            lead.status !== "ASSIGNED" &&
            lead.status !== "AWAITING_ACCEPTANCE" &&
            lead.status !== "AGENT_OPEN"
        ) {
            throw Object.assign(
                new Error(`Cannot accept shipment in status ${lead.status}`),
                { status: 422 }
            );
        }

        await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                status: "WORKING",
                acceptedAt: new Date(),
            },
        });
        await ensureGreenOsShipmentId(shipmentLeadId).catch(() => null);
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "BROKER_ACCEPTED_WORK",
            title: "Agent Working",
            message: "Status → Agent Working",
            actorUserId,
            timelineStage: "BROKER_ACCEPTED_WORK",
            payload: { status: "WORKING" },
        });
        return this.getShipmentCard(shipmentLeadId);
    }
}

export const crmService = new CrmService();
