import { prisma } from "../config/database.js";
import {
    diffMinutes,
    formatTime,
    formatMinutes,
    getAttendanceDayBounds,
    getAttendanceWorkDate,
    getAttendanceWorkHoursBounds,
    sumAttendanceOutsideMinutes,
} from "../utils/helpers.js";
import { config } from "../config/env.js";
import { employeeRepository } from "../repositories/employee.repository.js";
import {
    filterPeriodReportRows,
    groupNotArrivedByEmployee,
    isNotArrivedStatus,
    lastCountableWorkDate,
    listDateStrings,
    normalizeReportNameQuery,
    summarizePeriodReportRows,
    type PeriodReportFilters,
} from "./report-filter.js";

export type { PeriodReportFilters, PeriodReportSummary } from "./report-filter.js";

export interface PeriodReportRow {
    workDate: string;
    employeeId: string;
    employeeNumber: string;
    employeeName: string;
    department: string | null;
    position: string | null;
    firstEntry: string | null;
    lastExit: string | null;
    status: string;
    totalOutsideMinutes: number;
    timeInOfficeMinutes: number;
    overtimeInOfficeMinutes: number;
    exitCount: number;
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
    async getPeriodReport(from: string, to: string, filters: PeriodReportFilters = {}) {
        const employeeId = filters.employeeId?.trim() || undefined;
        const sessions = await prisma.attendanceSession.findMany({
            where: {
                workDate: { gte: from, lte: to },
                ...(employeeId ? { employeeId } : {}),
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
            const unclippedOutsideMinutes = s.absenceIntervals.reduce((sum, interval) => {
                if (interval.durationMinutes != null) {
                    return sum + interval.durationMinutes;
                }
                return sum + diffMinutes(interval.startTime, effectiveEnd);
            }, 0);
            const { workStart, workEnd } = getAttendanceWorkHoursBounds(
                s.workDate,
                config.timezone
            );
            const rawOutsideMinutes = sumAttendanceOutsideMinutes(
                s.absenceIntervals,
                now,
                workStart,
                workEnd
            );
            const timeInOfficeMinutes = calcTimeInOffice(
                s.firstEntry,
                effectiveEnd,
                unclippedOutsideMinutes
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
                position: s.employee.position,
                firstEntry: formatTime(s.firstEntry),
                lastExit: formatTime(s.lastExit),
                status: statusLabel(s.currentStatus),
                totalOutsideMinutes: rawOutsideMinutes,
                timeInOfficeMinutes,
                overtimeInOfficeMinutes,
                exitCount: s.exitCount,
            };
        });

        const filteredSessions = filterPeriodReportRows(rows, {
            employeeId,
            name: filters.name,
        });

        const employees = employeeId
            ? await prisma.employee.findMany({
                  where: { employeeId, status: "ACTIVE" },
              })
            : await employeeRepository.findAllActive();

        const notArrivedAll = buildNotArrivedRows({
            from,
            to,
            employees,
            sessionRows: rows,
            now,
        });
        const notArrivedRows = filterPeriodReportRows(notArrivedAll, {
            employeeId,
            name: filters.name,
        });
        const notArrivedByEmployee = groupNotArrivedByEmployee(notArrivedRows);
        const showNotArrived = isNotArrivedStatus(filters.status);
        const visibleRows = showNotArrived ? notArrivedRows : filteredSessions;
        const summary = summarizePeriodReportRows(
            showNotArrived ? notArrivedRows : filteredSessions,
            notArrivedRows
        );

        return {
            from,
            to,
            company: config.companyName,
            generatedAt: new Date().toISOString(),
            filters: {
                employeeId: employeeId || null,
                name: normalizeReportNameQuery(filters.name) ? filters.name?.trim() : null,
                status: showNotArrived ? "not_arrived" : null,
            },
            summary,
            rows: visibleRows,
            notArrivedRows,
            notArrivedByEmployee,
        };
    }

    formatMinutesForReport(minutes: number): string {
        return formatMinutes(minutes);
    }
}

function buildNotArrivedRows(input: {
    from: string;
    to: string;
    now: Date;
    employees: Array<{
        employeeId: string;
        employeeNumber: string;
        firstName: string;
        lastName: string;
        department: string | null;
        position: string | null;
    }>;
    sessionRows: PeriodReportRow[];
}): PeriodReportRow[] {
    const todayWorkDate = getAttendanceWorkDate(input.now, config.timezone);
    const shiftStart = getAttendanceDayBounds(todayWorkDate, config.timezone).scheduledStart;
    const last = lastCountableWorkDate(
        input.to,
        todayWorkDate,
        input.now >= shiftStart
    );
    if (!last || input.from > last) return [];

    const arrived = new Set(
        input.sessionRows
            .filter((row) => row.firstEntry)
            .map((row) => `${row.employeeId}|${row.workDate}`)
    );
    const rows: PeriodReportRow[] = [];
    for (const emp of input.employees) {
        for (const workDate of listDateStrings(input.from, last)) {
            if (arrived.has(`${emp.employeeId}|${workDate}`)) continue;
            rows.push({
                workDate,
                employeeId: emp.employeeId,
                employeeNumber: emp.employeeNumber,
                employeeName: `${emp.firstName} ${emp.lastName}`,
                department: emp.department,
                position: emp.position,
                firstEntry: null,
                lastExit: null,
                status: "Not Arrived",
                totalOutsideMinutes: 0,
                timeInOfficeMinutes: 0,
                overtimeInOfficeMinutes: 0,
                exitCount: 0,
            });
        }
    }
    rows.sort((a, b) => {
        const byDate = b.workDate.localeCompare(a.workDate);
        if (byDate !== 0) return byDate;
        return a.employeeName.localeCompare(b.employeeName, undefined, { sensitivity: "base" });
    });
    return rows;
}

export const reportService = new ReportService();
