import { prisma } from "../config/database.js";
import {
    diffMinutes,
    excessOutsideMinutes,
    formatDateTime,
    formatMinutes,
} from "../utils/helpers.js";
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
    effectiveEnd: Date,
    rawOutsideMinutes: number
): number {
    if (!firstEntry) return 0;
    const gross = diffMinutes(firstEntry, effectiveEnd);
    return Math.max(0, gross - rawOutsideMinutes);
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
                absenceIntervals: { orderBy: { startTime: "asc" } },
            },
            orderBy: [{ workDate: "desc" }, { employee: { lastName: "asc" } }],
        });

        const now = new Date();
        const rows: PeriodReportRow[] = sessions.map((s) => {
            const effectiveEnd = now < s.scheduledEnd ? now : s.scheduledEnd;
            const rawOutsideMinutes = s.absenceIntervals.reduce((sum, interval) => {
                if (interval.durationMinutes != null) {
                    return sum + interval.durationMinutes;
                }
                return sum + diffMinutes(interval.startTime, effectiveEnd);
            }, 0);
            const timeInOfficeMinutes = calcTimeInOffice(
                s.firstEntry,
                effectiveEnd,
                rawOutsideMinutes
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
                totalOutsideMinutes: excessOutsideMinutes(rawOutsideMinutes),
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
