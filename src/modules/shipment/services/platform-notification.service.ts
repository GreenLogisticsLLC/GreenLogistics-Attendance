import { prisma } from "../../../config/database.js";

/**
 * Sprint F — GreenOS Notification Center (independent from Gmail).
 * Built from Domain Events / assignment / lifecycle actions.
 */

export const NOTIFICATION_TYPES = [
    "SHIPMENT_ASSIGNED",
    "CUSTOMER_REPLIED",
    "BID_ACCEPTED",
    "LOAD_NUMBER_RECEIVED",
    "SHIPMENT_BOOKED",
    "SHIPMENT_LOST",
    "SHIPMENT_ACCEPTED_ANOTHER_COMPANY",
    "SHIPMENT_DELETED_BY_CUSTOMER",
    "TIMELINE_EVENT",
    "BID_SUBMITTED",
] as const;

export type PlatformNotificationType = (typeof NOTIFICATION_TYPES)[number] | string;

export class PlatformNotificationService {
    async notifyUser(input: {
        userId: string;
        notificationType: PlatformNotificationType;
        title: string;
        message: string;
        shipmentLeadId?: string;
        meta?: Record<string, unknown>;
    }) {
        // One logical alert per shipment+type+title — do not flood Notification Center.
        if (input.shipmentLeadId) {
            const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
            const existing = await prisma.platformNotification.findFirst({
                where: {
                    userId: input.userId,
                    shipmentLeadId: input.shipmentLeadId,
                    notificationType: input.notificationType,
                    title: input.title,
                    createdAt: { gte: since },
                },
                orderBy: { createdAt: "desc" },
            });
            if (existing) return existing;
        }

        return prisma.platformNotification.create({
            data: {
                userId: input.userId,
                shipmentLeadId: input.shipmentLeadId,
                notificationType: input.notificationType,
                title: input.title,
                message: input.message,
                metaJson: input.meta ? JSON.stringify(input.meta) : undefined,
            },
        });
    }

    async notifyRoles(input: {
        roles: string[];
        notificationType: PlatformNotificationType;
        title: string;
        message: string;
        shipmentLeadId?: string;
        meta?: Record<string, unknown>;
        excludeUserId?: string;
    }) {
        const users = await prisma.user.findMany({
            where: {
                isActive: true,
                role: { roleName: { in: input.roles } },
                ...(input.excludeUserId ? { userId: { not: input.excludeUserId } } : {}),
            },
            select: { userId: true },
        });
        if (!users.length) return [];
        await prisma.platformNotification.createMany({
            data: users.map((u) => ({
                userId: u.userId,
                roleAudience: input.roles.join(","),
                shipmentLeadId: input.shipmentLeadId,
                notificationType: input.notificationType,
                title: input.title,
                message: input.message,
                metaJson: input.meta ? JSON.stringify(input.meta) : undefined,
            })),
        });
        return users;
    }

    async listForUser(
        userId: string,
        options?: {
            unreadOnly?: boolean;
            limit?: number;
            /** When set, hide notifications for shipments assigned to someone else. */
            onlyAssignedToUserId?: string;
        }
    ) {
        const rows = await prisma.platformNotification.findMany({
            where: {
                userId,
                ...(options?.unreadOnly ? { status: "UNREAD" } : {}),
            },
            orderBy: { createdAt: "desc" },
            take: Math.min(300, Math.max(1, options?.limit ?? 100)),
        });

        if (!options?.onlyAssignedToUserId) return rows;

        const ownerId = options.onlyAssignedToUserId;
        const withLead = rows.filter((r) => r.shipmentLeadId);
        if (!withLead.length) return rows;

        const leads = await prisma.shipmentLead.findMany({
            where: {
                shipmentLeadId: {
                    in: withLead.map((r) => r.shipmentLeadId!).filter(Boolean),
                },
            },
            select: { shipmentLeadId: true, assignedBrokerId: true },
        });
        const ownerByLead = new Map(
            leads.map((l) => [l.shipmentLeadId, l.assignedBrokerId || ""])
        );

        return rows.filter((r) => {
            if (!r.shipmentLeadId) return true;
            const assigned = ownerByLead.get(r.shipmentLeadId);
            // Drop stale alerts for cards that moved to another broker (or were purged).
            if (assigned == null) return false;
            return assigned === ownerId;
        });
    }

    async unreadCount(userId: string) {
        return prisma.platformNotification.count({
            where: { userId, status: "UNREAD" },
        });
    }

    async markRead(notificationId: string, userId: string) {
        const row = await prisma.platformNotification.findFirst({
            where: { notificationId, userId },
        });
        if (!row) return null;
        return prisma.platformNotification.update({
            where: { notificationId },
            data: { status: "READ", readAt: new Date() },
        });
    }

    async markAllRead(userId: string) {
        const result = await prisma.platformNotification.updateMany({
            where: { userId, status: "UNREAD" },
            data: { status: "READ", readAt: new Date() },
        });
        return result.count;
    }
}

export const platformNotificationService = new PlatformNotificationService();
