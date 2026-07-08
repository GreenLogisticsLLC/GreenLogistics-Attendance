import { prisma } from "../config/database.js";

export class AttendanceEventRepository {
    async findByWebhookId(webhookId: string) {
        return prisma.attendanceEvent.findUnique({
            where: { webhookId },
        });
    }

    async create(data: {
        sessionId: string;
        employeeId: string;
        eventTime: Date;
        direction: string;
        eventType: string;
        deviceId: string;
        webhookId: string;
        source?: string;
    }) {
        return prisma.attendanceEvent.create({ data });
    }

    async findBySession(sessionId: string) {
        return prisma.attendanceEvent.findMany({
            where: { sessionId },
            orderBy: { eventTime: "asc" },
        });
    }
}

export const attendanceEventRepository = new AttendanceEventRepository();
