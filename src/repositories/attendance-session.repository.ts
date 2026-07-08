import { prisma } from "../config/database.js";

export class AttendanceSessionRepository {
    async findByEmployeeAndWorkDate(employeeId: string, workDate: string) {
        return prisma.attendanceSession.findUnique({
            where: {
                employeeId_workDate: { employeeId, workDate },
            },
            include: {
                absenceIntervals: {
                    where: { endTime: null },
                    orderBy: { startTime: "desc" },
                    take: 1,
                },
            },
        });
    }

    async findLatestSessionForEmployee(employeeId: string, workDate: string) {
        const workDateSession = await this.findByEmployeeAndWorkDate(employeeId, workDate);
        if (workDateSession) {
            return workDateSession;
        }

        return prisma.attendanceSession.findFirst({
            where: {
                employeeId,
                lastActivity: {
                    gte: new Date(Date.now() - 48 * 60 * 60 * 1000),
                },
            },
            orderBy: { lastActivity: "desc" },
            include: {
                absenceIntervals: {
                    where: { endTime: null },
                    orderBy: { startTime: "desc" },
                    take: 1,
                },
            },
        });
    }

    async create(data: {
        employeeId: string;
        shiftId: string;
        workDate: string;
        scheduledStart: Date;
        scheduledEnd: Date;
    }) {
        return prisma.attendanceSession.create({ data });
    }

    async update(sessionId: string, data: Record<string, unknown>) {
        return prisma.attendanceSession.update({
            where: { sessionId },
            data,
        });
    }

    async findTodaySessions(workDate: string) {
        return prisma.attendanceSession.findMany({
            where: { workDate },
            include: {
                employee: { include: { shift: true } },
                shift: true,
                absenceIntervals: {
                    where: { endTime: null },
                    orderBy: { startTime: "desc" },
                    take: 1,
                },
            },
            orderBy: { updatedAt: "desc" },
        });
    }

    async findRecentActiveSession(employeeId: string) {
        return prisma.attendanceSession.findFirst({
            where: {
                employeeId,
                currentStatus: { in: ["INSIDE_OFFICE", "OUTSIDE_OFFICE"] },
                lastActivity: {
                    gte: new Date(Date.now() - 48 * 60 * 60 * 1000),
                },
            },
            orderBy: { lastActivity: "desc" },
            include: {
                absenceIntervals: {
                    where: { endTime: null },
                    orderBy: { startTime: "desc" },
                    take: 1,
                },
            },
        });
    }

    async findById(sessionId: string) {
        return prisma.attendanceSession.findUnique({
            where: { sessionId },
            include: {
                employee: { include: { shift: true } },
                shift: true,
                attendanceEvents: { orderBy: { eventTime: "asc" } },
                absenceIntervals: { orderBy: { startTime: "asc" } },
            },
        });
    }
}

export const attendanceSessionRepository = new AttendanceSessionRepository();
