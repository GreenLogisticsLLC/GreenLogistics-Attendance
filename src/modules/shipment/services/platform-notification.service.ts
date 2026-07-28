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

    async listForUser(userId: string, options?: { unreadOnly?: boolean; limit?: number }) {
        return prisma.platformNotification.findMany({
            where: {
                userId,
                ...(options?.unreadOnly ? { status: "UNREAD" } : {}),
            },
            orderBy: { createdAt: "desc" },
            take: options?.limit ?? 100,
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
