import { config } from "../config/env.js";
import { prisma } from "../config/database.js";
import {
    ATTENDANCE_BREAK_ALLOWANCE_MINUTES,
    addDaysToDateString,
    diffMinutes,
    excessOutsideMinutes,
    formatDateTime,
    getAttendanceDayBounds,
    getAttendanceWorkDate,
} from "../utils/helpers.js";
import { employeeRepository } from "../repositories/employee.repository.js";
import { attendanceSessionRepository } from "../repositories/attendance-session.repository.js";
import { getEmployeePresenceSession, getEmployeePresenceSessionsMap } from "./attendance-presence.service.js";
import type {
    DashboardEmployeeRow,
    DashboardStatistics,
} from "../types/attendance.types.js";

export class DashboardService {
    /** Lightweight stats for GreenOS shell — skips per-employee row building. */
    async getStatisticsOnly(date?: string, options?: { teamLeadUserId?: string | null }) {
        const now = new Date();
        let employees = await employeeRepository.findAllActive();
        if (options?.teamLeadUserId) {
            const { listTeamEmployeeIds } = await import("../auth/team-scope.js");
            const allowed = new Set(await listTeamEmployeeIds(options.teamLeadUserId));
            employees = employees.filter((e) => allowed.has(e.employeeId));
        }

        const workDate = date || getAttendanceWorkDate(now, config.timezone);
        const sessionsMap = await getEmployeePresenceSessionsMap(
            employees.map((e) => e.employeeId)
        );

        let employeesPresent = 0;
        let employeesOutside = 0;
        let employeesOvertime = 0;
        let employeesLate = 0;
        let employeesNotArrived = 0;
        let completedSessions = 0;

        for (const emp of employees) {
            const session = sessionsMap.get(emp.employeeId) ?? null;
            const currentStatus = session?.currentStatus ?? "SCHEDULED";

            if (currentStatus === "INSIDE_OFFICE") {
                employeesPresent++;
                const overtimeEnd = now;
                const overtimeStart =
                    session?.firstEntry && session.firstEntry > session.scheduledEnd
                        ? session.firstEntry
                        : session?.scheduledEnd;
                if (
                    session &&
                    overtimeStart &&
                    overtimeEnd > overtimeStart
                ) {
                    employeesOvertime++;
                }
            } else if (currentStatus === "OUTSIDE_OFFICE") {
                employeesOutside++;
            } else if (currentStatus === "COMPLETED") {
                completedSessions++;
            }

            if (session?.late && (session.lateMinutes || 0) > 0) {
                employeesLate++;
            }
            if (!session?.firstEntry && currentStatus === "SCHEDULED") {
                employeesNotArrived++;
            }
        }

        const statistics: DashboardStatistics = {
            employeesScheduled: employees.length,
            employeesPresent,
            employeesOutside,
            employeesOvertime,
            employeesLate,
            employeesNotArrived,
            completedSessions,
        };

        return { workDate, statistics };
    }

    async getDashboard(date?: string, options?: { teamLeadUserId?: string | null }) {
        const now = new Date();
        let employees = await employeeRepository.findAllActive();
        if (options?.teamLeadUserId) {
            const { listTeamEmployeeIds } = await import("../auth/team-scope.js");
            const allowed = new Set(await listTeamEmployeeIds(options.teamLeadUserId));
            employees = employees.filter((e) => allowed.has(e.employeeId));
        }

        const workDate =
            date ||
            getAttendanceWorkDate(now, config.timezone);

        const rows: DashboardEmployeeRow[] = [];
        const currentBounds = getAttendanceDayBounds(workDate, config.timezone);

        for (const emp of employees) {
            let session = date
                ? await attendanceSessionRepository.findByEmployeeAndWorkDate(
                      emp.employeeId,
                      workDate
                  )
                : await getEmployeePresenceSession(emp.employeeId);
            if (date && (!session || session.currentStatus === "SCHEDULED") && now < currentBounds.scheduledStart) {
                const previous = await attendanceSessionRepository.findByEmployeeAndWorkDate(
                    emp.employeeId,
                    addDaysToDateString(workDate, -1)
                );
                if (
                    previous?.currentStatus === "INSIDE_OFFICE" &&
                    now >= previous.scheduledEnd
                ) {
                    session = previous;
                }
            }

            const openInterval = session?.absenceIntervals?.[0];
            const effectiveNow = now;

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
            const overtimeEnd =
                session?.currentStatus === "INSIDE_OFFICE"
                    ? now
                    : session?.lastExit || session?.lastActivity || session?.scheduledEnd;
            const overtimeStart =
                session?.firstEntry && session.firstEntry > session.scheduledEnd
                    ? session.firstEntry
                    : session?.scheduledEnd;
            const overtimeInOfficeMinutes =
                session && overtimeStart && overtimeEnd && overtimeEnd > overtimeStart
                    ? diffMinutes(overtimeStart, overtimeEnd)
                    : 0;

            rows.push({
                employeeId: emp.employeeId,
                employeeNumber: emp.employeeNumber,
                employeeName: `${emp.firstName} ${emp.lastName}`,
                department: emp.department,
                position: emp.position,
                scheduledStart: formatDateTime(session?.scheduledStart ?? null) || "—",
                firstEntry: formatDateTime(session?.firstEntry ?? null),
                lastExit: formatDateTime(session?.lastExit ?? null),
                currentStatus: session?.currentStatus ?? "SCHEDULED",
                late: Boolean(session?.late),
                lateMinutes: session?.lateMinutes ?? 0,
                currentAbsenceMinutes,
                currentOfficeMinutes,
                totalAbsenceMinutes: excessOutsideMinutes(rawOutsideMinutes),
                rawOutsideMinutes,
                breakAllowanceMinutes: ATTENDANCE_BREAK_ALLOWANCE_MINUTES,
                overtimeInOfficeMinutes,
                exitCount: session?.exitCount ?? 0,
                lastActivity: formatDateTime(session?.lastActivity ?? null),
            });
        }

        const statistics: DashboardStatistics = {
            employeesScheduled: employees.length,
            employeesPresent: rows.filter((r) => r.currentStatus === "INSIDE_OFFICE").length,
            employeesOutside: rows.filter((r) => r.currentStatus === "OUTSIDE_OFFICE").length,
            employeesOvertime: rows.filter(
                (r) => r.currentStatus === "INSIDE_OFFICE" && r.overtimeInOfficeMinutes > 0
            ).length,
            employeesLate: rows.filter((r) => r.late && (r.lateMinutes || 0) > 0).length,
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
        let session = await attendanceSessionRepository.findByEmployeeAndWorkDate(
            employeeId,
            date
        );
        if (!workDate && !session) {
            const bounds = getAttendanceDayBounds(date, config.timezone);
            if (now < bounds.scheduledStart) {
                const previous = await attendanceSessionRepository.findByEmployeeAndWorkDate(
                    employeeId,
                    addDaysToDateString(date, -1)
                );
                if (
                    previous?.currentStatus === "INSIDE_OFFICE" &&
                    now >= previous.scheduledEnd
                ) {
                    session = previous;
                }
            }
        }

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

        const brokerUser = await prisma.user.findFirst({
            where: { employeeId, role: { roleName: "Broker" } },
            select: {
                brokerGmailAccount: {
                    select: {
                        gmailAddress: true,
                        status: true,
                        lastSyncAt: true,
                        lastError: true,
                        connectedAt: true,
                    },
                },
            },
        });
        const gmail = brokerUser
            ? brokerUser.brokerGmailAccount || {
                  gmailAddress: null,
                  status: "DISCONNECTED",
                  lastSyncAt: null,
                  lastError: null,
                  connectedAt: null,
              }
            : null;

        return { employee, session, events, intervals, gmail, workDate: date };
    }
}

export const dashboardService = new DashboardService();
