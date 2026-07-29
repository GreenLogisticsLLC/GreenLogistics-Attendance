import { config } from "../config/env.js";
import { prisma } from "../config/database.js";
import {
    ATTENDANCE_BREAK_ALLOWANCE_MINUTES,
    diffMinutes,
    excessOutsideMinutes,
    formatDateTime,
    getAttendanceWorkDate,
} from "../utils/helpers.js";
import { employeeRepository } from "../repositories/employee.repository.js";
import { attendanceSessionRepository } from "../repositories/attendance-session.repository.js";
import type {
    DashboardEmployeeRow,
    DashboardStatistics,
} from "../types/attendance.types.js";

export class DashboardService {
    async getDashboard(date?: string) {
        const now = new Date();
        const employees = await employeeRepository.findAllActive();

        const workDate =
            date ||
            getAttendanceWorkDate(now, config.timezone);

        const rows: DashboardEmployeeRow[] = [];

        for (const emp of employees) {
            // Never carry First Entry or presence across the 02:00 daily reset.
            const session = await attendanceSessionRepository.findByEmployeeAndWorkDate(
                emp.employeeId,
                workDate
            );

            const openInterval = session?.absenceIntervals?.[0];
            const effectiveNow =
                session && now > session.scheduledEnd ? session.scheduledEnd : now;

            let currentAbsenceMinutes = 0;
            let currentOfficeMinutes = 0;
            if (session?.currentStatus === "OUTSIDE_OFFICE" && openInterval) {
                currentAbsenceMinutes = diffMinutes(openInterval.startTime, effectiveNow);
            } else if (session?.currentStatus === "INSIDE_OFFICE") {
                const since = session.lastActivity ?? session.firstEntry;
                if (since) {
                    currentOfficeMinutes = diffMinutes(since, effectiveNow);
                }
            }
            const rawOutsideMinutes =
                (session?.totalAbsenceMinutes ?? 0) + currentAbsenceMinutes;

            rows.push({
                employeeId: emp.employeeId,
                employeeNumber: emp.employeeNumber,
                employeeName: `${emp.firstName} ${emp.lastName}`,
                department: emp.department,
                position: emp.position,
                shiftName: emp.shift?.shiftName || "Flexible",
                scheduledStart: formatDateTime(session?.scheduledStart ?? null) || "—",
                firstEntry: formatDateTime(session?.firstEntry ?? null),
                lastExit: formatDateTime(session?.lastExit ?? null),
                currentStatus: session?.currentStatus ?? "SCHEDULED",
                currentAbsenceMinutes,
                currentOfficeMinutes,
                totalAbsenceMinutes: excessOutsideMinutes(rawOutsideMinutes),
                rawOutsideMinutes,
                breakAllowanceMinutes: ATTENDANCE_BREAK_ALLOWANCE_MINUTES,
                late: session?.late ?? false,
                lateMinutes: session?.lateMinutes ?? 0,
                exitCount: session?.exitCount ?? 0,
                lastActivity: formatDateTime(session?.lastActivity ?? null),
            });
        }

        const statistics: DashboardStatistics = {
            employeesScheduled: employees.length,
            employeesPresent: rows.filter((r) => r.currentStatus === "INSIDE_OFFICE").length,
            employeesOutside: rows.filter((r) => r.currentStatus === "OUTSIDE_OFFICE").length,
            employeesLate: rows.filter((r) => r.late).length,
            employeesNotArrived: rows.filter(
                (r) => !r.firstEntry && r.currentStatus === "SCHEDULED"
            ).length,
            completedSessions: rows.filter((r) => r.currentStatus === "COMPLETED").length,
        };

        const notifications = await prisma.notification.findMany({
            where: { status: "UNREAD" },
            orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
            take: 20,
            include: { employee: true },
        });

        const recentWebhooks = await prisma.webhookLog.findMany({
            orderBy: { requestTime: "desc" },
            take: 10,
        });

        return {
            workDate,
            statistics,
            employees: rows,
            notifications,
            systemHealth: {
                database: "ONLINE",
                api: "ONLINE",
                webhook: recentWebhooks.some(
                    (w) =>
                        w.processingStatus === "FAILED" &&
                        Date.now() - w.requestTime.getTime() < 3600000
                )
                    ? "WARNING"
                    : "ONLINE",
                queue: "ONLINE",
            },
            recentWebhooks,
        };
    }

    async getEmployeeDetail(employeeId: string, workDate?: string) {
        const now = new Date();
        const employee = await employeeRepository.findById(employeeId);
        if (!employee) return null;

        const date = workDate || getAttendanceWorkDate(now, config.timezone);
        const session = await attendanceSessionRepository.findByEmployeeAndWorkDate(
            employeeId,
            date
        );

        let events: Awaited<ReturnType<typeof prisma.attendanceEvent.findMany>> = [];
        let intervals: Awaited<ReturnType<typeof prisma.absenceInterval.findMany>> = [];

        if (session) {
            events = await prisma.attendanceEvent.findMany({
                where: { sessionId: session.sessionId },
                orderBy: { eventTime: "asc" },
            });
            intervals = await prisma.absenceInterval.findMany({
                where: { sessionId: session.sessionId },
                orderBy: { startTime: "asc" },
            });
        }

        return { employee, session, events, intervals, workDate: date };
    }
}

export const dashboardService = new DashboardService();
