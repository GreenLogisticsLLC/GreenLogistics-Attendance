import { prisma } from "../../../config/database.js";
import { config } from "../../../config/env.js";
import {
    ACTIVE_STATUSES,
    STATUS_LABELS,
    TIMELINE_STAGES,
} from "../crm.constants.js";
import { shipmentTimelineService } from "./timeline.service.js";

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
        statusLabel: STATUS_LABELS[lead.status as string] || (lead.status as string),
        ushipUrl: lead.viewUrl || null,
    };
}

export class CrmService {
    async getDashboard() {
        const todayStart = startOfToday(config.timezone);

        const [
            newToday,
            awaiting,
            quotesSent,
            won,
            lost,
            active,
            brokers,
        ] = await Promise.all([
            prisma.shipmentLead.count({
                where: { createdAt: { gte: todayStart } },
            }),
            prisma.shipmentLead.count({ where: { status: "AWAITING_ACCEPTANCE" } }),
            prisma.shipmentLead.count({ where: { status: "QUOTE_SENT" } }),
            prisma.shipmentLead.count({ where: { status: "WON" } }),
            prisma.shipmentLead.count({ where: { status: "LOST" } }),
            prisma.shipmentLead.count({ where: { status: { in: [...ACTIVE_STATUSES] } } }),
            this.getBrokerWorkload(),
        ]);

        const avgResponseMs = await this.averageResponseTimeMs();

        return {
            version: "1.0",
            kpis: {
                newShipmentsToday: newToday,
                awaitingAcceptance: awaiting,
                quotesSent,
                won,
                lost,
                activeShipments: active,
                averageResponseTimeMinutes: avgResponseMs == null ? null : Math.round(avgResponseMs / 60000),
            },
            brokerWorkload: brokers.map((b) => ({
                brokerId: b.brokerId,
                name: b.name,
                activeShipments: b.currentShipments,
            })),
        };
    }

    private async averageResponseTimeMs(): Promise<number | null> {
        const rows = await prisma.shipmentLead.findMany({
            where: { assignedAt: { not: null }, acceptedAt: { not: null } },
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

    async listShipments(options?: { brokerId?: string; status?: string; limit?: number }) {
        const where: Record<string, unknown> = {};
        if (options?.brokerId) where.assignedBrokerId = options.brokerId;
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
            },
        });
        if (!lead) return null;

        const brokers = await userMap(lead.assignedBrokerId ? [lead.assignedBrokerId] : []);
        const enriched = enrichLead(lead as unknown as Record<string, unknown>, brokers);

        const occurred = new Set(lead.timelineEvents.map((e) => e.stage));
        const pipeline = TIMELINE_STAGES.map((s) => ({
            ...s,
            done: occurred.has(s.stage),
            at: lead.timelineEvents.find((e) => e.stage === s.stage)?.createdAt || null,
        }));

        let documents: unknown[] = [];
        try {
            documents = lead.documentsJson ? JSON.parse(lead.documentsJson) : [];
        } catch {
            documents = [];
        }

        return {
            ...enriched,
            documents,
            timeline: lead.timelineEvents,
            pipeline,
            email: lead.emailMessage
                ? {
                      subject: lead.emailMessage.subject,
                      from: lead.emailMessage.fromAddress,
                      receivedAt: lead.emailMessage.receivedAt,
                  }
                : null,
        };
    }

    async getBrokerWorkload() {
        const brokers = await prisma.user.findMany({
            where: {
                isActive: true,
                role: { roleName: { in: ["Broker", "Manager", "Owner"] } },
            },
            include: { role: true },
            orderBy: { firstName: "asc" },
        });
        const preferred = brokers.filter((b) => b.role.roleName === "Broker");
        const pool = preferred.length ? preferred : brokers;

        const result = [];
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

            result.push({
                brokerId: b.userId,
                name: brokerName(b),
                username: b.username,
                role: b.role.roleName,
                status: b.isActive ? "Active" : "Inactive",
                online: b.isActive,
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
            include: { role: true },
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
        extras?: { notes?: string; price?: number; priority?: string }
    ) {
        const data: Record<string, unknown> = { status };
        if (extras?.notes !== undefined) data.notes = extras.notes;
        if (extras?.price !== undefined) data.price = extras.price;
        if (extras?.priority !== undefined) data.priority = extras.priority;

        const stageByStatus: Record<string, { stage: string; title: string }> = {
            AWAITING_ACCEPTANCE: { stage: "ASSIGNED", title: "Assigned to Broker" },
            FOLLOW_UP: { stage: "ASSIGNED", title: "Needs Follow Up" },
            QUOTE_SENT: { stage: "QUOTE_SENT", title: "Quote Sent" },
            NEGOTIATION: { stage: "NEGOTIATION", title: "Negotiation" },
            BOOKED: { stage: "BOOKED", title: "Booked" },
            PICKED_UP: { stage: "PICKED_UP", title: "Picked Up" },
            DELIVERED: { stage: "DELIVERED", title: "Delivered" },
            WON: { stage: "COMPLETED", title: "Won" },
            LOST: { stage: "COMPLETED", title: "Lost" },
            COMPLETED: { stage: "COMPLETED", title: "Completed" },
        };

        if (status === "QUOTE_SENT") data.quoteSentAt = new Date();
        if (status === "WON" || status === "LOST" || status === "COMPLETED") {
            data.closedAt = new Date();
        }
        if (status === "ASSIGNED" || status === "AWAITING_ACCEPTANCE") {
            // acceptance can be recorded via accept endpoint
        }

        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data,
        });

        const mapped = stageByStatus[status];
        if (mapped) {
            await shipmentTimelineService.addEvent({
                shipmentLeadId,
                stage: mapped.stage,
                title: mapped.title,
                message: `Status → ${STATUS_LABELS[status] || status}`,
                actorUserId,
            });
        }

        return this.getShipmentCard(shipmentLeadId) || updated;
    }

    async acceptShipment(shipmentLeadId: string, actorUserId: string) {
        await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                status: "FOLLOW_UP",
                acceptedAt: new Date(),
            },
        });
        await shipmentTimelineService.addEvent({
            shipmentLeadId,
            stage: "BROKER_ACCEPTED",
            title: "Broker Accepted",
            actorUserId,
        });
        return this.getShipmentCard(shipmentLeadId);
    }
}

export const crmService = new CrmService();
