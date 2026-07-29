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
    firstEntry: string | null;
    lastExit: string | null;
    status: string;
    totalOutsideMinutes: number;
    timeInOfficeMinutes: number;
    overtimeInOfficeMinutes: number;
    exitCount: number;
}

export interface PeriodReportSummary {
    totalSessions: number;
    daysWithEntry: number;
    totalOutsideMinutes: number;
    totalInOfficeMinutes: number;
    totalOvertimeMinutes: number;
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
                employee: true,
                absenceIntervals: { orderBy: { startTime: "asc" } },
            },
            orderBy: [{ workDate: "desc" }, { employee: { lastName: "asc" } }],
        });

        const now = new Date();
        const rows: PeriodReportRow[] = sessions.map((s) => {
            let effectiveEnd = now < s.scheduledEnd ? now : s.scheduledEnd;
            if (s.currentStatus === "INSIDE_OFFICE") {
                effectiveEnd = now;
            } else if (s.lastExit && s.lastExit > s.scheduledEnd) {
                effectiveEnd = s.lastExit;
            } else if (
                s.currentStatus === "COMPLETED" &&
                s.lastActivity &&
                s.lastActivity > s.scheduledEnd
            ) {
                effectiveEnd = s.lastActivity;
            }
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
            const overtimeStart =
                s.firstEntry && s.firstEntry > s.scheduledEnd
                    ? s.firstEntry
                    : s.scheduledEnd;
            const overtimeOutsideMinutes = s.absenceIntervals.reduce((sum, interval) => {
                const intervalEnd = interval.endTime || effectiveEnd;
                const overlapStart =
                    interval.startTime > overtimeStart ? interval.startTime : overtimeStart;
                const overlapEnd = intervalEnd < effectiveEnd ? intervalEnd : effectiveEnd;
                return sum + (overlapEnd > overlapStart ? diffMinutes(overlapStart, overlapEnd) : 0);
            }, 0);
            const overtimeInOfficeMinutes = s.firstEntry
                ? Math.max(
                      0,
                      diffMinutes(overtimeStart, effectiveEnd) - overtimeOutsideMinutes
                  )
                : 0;

            return {
                workDate: s.workDate,
                employeeId: s.employeeId,
                employeeNumber: s.employee.employeeNumber,
                employeeName: `${s.employee.firstName} ${s.employee.lastName}`,
                department: s.employee.department,
                firstEntry: formatDateTime(s.firstEntry),
                lastExit: formatDateTime(s.lastExit),
                status: statusLabel(s.currentStatus),
                totalOutsideMinutes: excessOutsideMinutes(rawOutsideMinutes),
                timeInOfficeMinutes,
                overtimeInOfficeMinutes,
                exitCount: s.exitCount,
            };
        });

        const summary: PeriodReportSummary = {
            totalSessions: rows.length,
            daysWithEntry: rows.filter((r) => r.firstEntry).length,
            totalOutsideMinutes: rows.reduce((s, r) => s + r.totalOutsideMinutes, 0),
            totalInOfficeMinutes: rows.reduce((s, r) => s + r.timeInOfficeMinutes, 0),
            totalOvertimeMinutes: rows.reduce(
                (s, r) => s + r.overtimeInOfficeMinutes,
                0
            ),
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
