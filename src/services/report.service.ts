import { prisma } from "../config/database.js";
import { diffMinutes, formatDateTime, formatMinutes } from "../utils/helpers.js";
import { config } from "../config/env.js";

export interface PeriodReportRow {
    workDate: string;
    employeeId: string;
    employeeNumber: string;
    employeeName: string;
    department: string | null;
    shiftName: string;
    firstEntry: string | null;
    lastExit: string | null;
    status: string;
    lateMinutes: number;
    totalOutsideMinutes: number;
    timeInOfficeMinutes: number;
    exitCount: number;
}

export interface PeriodReportSummary {
    totalSessions: number;
    daysWithEntry: number;
    totalLateMinutes: number;
    totalOutsideMinutes: number;
    totalInOfficeMinutes: number;
}

function calcTimeInOffice(
    firstEntry: Date | null,
    lastExit: Date | null,
    lastActivity: Date | null,
    currentStatus: string,
    totalAbsenceMinutes: number,
    now: Date
): number {
    if (!firstEntry) return 0;

    let end: Date;
    if (lastExit) {
        end = lastExit;
    } else if (currentStatus === "INSIDE_OFFICE" && lastActivity) {
        end = lastActivity > now ? lastActivity : now;
    } else if (lastActivity) {
        end = lastActivity;
    } else {
        end = firstEntry;
    }

    const gross = diffMinutes(firstEntry, end);
    return Math.max(0, gross - totalAbsenceMinutes);
}

function statusLabel(status: string): string {
    const map: Record<string, string> = {
        INSIDE_OFFICE: "In Office",
        OUTSIDE_OFFICE: "Outside",
        SCHEDULED: "Not Arrived",
        COMPLETED: "Left",
        EXCEPTION: "Exception",
    };
    return map[status] || status;
}

export class ReportService {
    async getPeriodReport(from: string, to: string) {
        const sessions = await prisma.attendanceSession.findMany({
            where: {
                workDate: { gte: from, lte: to },
            },
            include: {
                employee: { include: { shift: true } },
            },
            orderBy: [{ workDate: "desc" }, { employee: { lastName: "asc" } }],
        });

        const now = new Date();
        const rows: PeriodReportRow[] = sessions.map((s) => {
            const timeInOfficeMinutes = calcTimeInOffice(
                s.firstEntry,
                s.lastExit,
                s.lastActivity,
                s.currentStatus,
                s.totalAbsenceMinutes,
                now
            );

            return {
                workDate: s.workDate,
                employeeId: s.employeeId,
                employeeNumber: s.employee.employeeNumber,
                employeeName: `${s.employee.firstName} ${s.employee.lastName}`,
                department: s.employee.department,
                shiftName: s.employee.shift.shiftName,
                firstEntry: formatDateTime(s.firstEntry),
                lastExit: formatDateTime(s.lastExit),
                status: statusLabel(s.currentStatus),
                lateMinutes: s.lateMinutes,
                totalOutsideMinutes: s.totalAbsenceMinutes,
                timeInOfficeMinutes,
                exitCount: s.exitCount,
            };
        });

        const summary: PeriodReportSummary = {
            totalSessions: rows.length,
            daysWithEntry: rows.filter((r) => r.firstEntry).length,
            totalLateMinutes: rows.reduce((s, r) => s + r.lateMinutes, 0),
            totalOutsideMinutes: rows.reduce((s, r) => s + r.totalOutsideMinutes, 0),
            totalInOfficeMinutes: rows.reduce((s, r) => s + r.timeInOfficeMinutes, 0),
        };

        return {
            from,
            to,
            company: config.companyName,
            generatedAt: new Date().toISOString(),
            summary,
            rows,
        };
    }

    formatMinutesForReport(minutes: number): string {
        return formatMinutes(minutes);
    }
}

export const reportService = new ReportService();
