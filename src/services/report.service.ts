import { prisma } from "../config/database.js";
import {
    ASSIGNMENT_TIMEZONE,
    arrivalIsDayOff,
    DAY_OFF_STARTS_ON,
    diffMinutes,
    formatMinutes,
    formatYerevanTime,
    getAttendanceDayBounds,
    getAttendanceWorkDate,
    getAttendanceWorkHoursBounds,
    overlapMinutes,
} from "../utils/helpers.js";
import { config } from "../config/env.js";
import { employeeRepository } from "../repositories/employee.repository.js";
import {
    filterPeriodReportRows,
    groupDayOffByEmployee,
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
    dayOff: boolean;
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
        const scopedIds = filters.employeeIds;
        const allowedIds =
            scopedIds == null
                ? null
                : employeeId
                  ? scopedIds.includes(employeeId)
                      ? [employeeId]
                      : []
                  : scopedIds;
        const idWhere =
            allowedIds != null
                ? { employeeId: { in: allowedIds } }
                : employeeId
                  ? { employeeId }
                  : {};
        const sessions = await prisma.attendanceSession.findMany({
            where: {
                workDate: { gte: from, lte: to },
                ...idWhere,
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
            const { workStart, workEnd } = getAttendanceWorkHoursBounds(
                s.workDate,
                ASSIGNMENT_TIMEZONE
            );
            const presenceEnd =
                s.currentStatus === "INSIDE_OFFICE"
                    ? now
                    : s.lastExit || s.lastActivity || effectiveEnd;
            const cappedEnd = presenceEnd < workEnd ? presenceEnd : workEnd;
            const outsideDuringShift = s.absenceIntervals.reduce((sum, interval) => {
                const intervalEnd = interval.endTime || now;
                return sum + overlapMinutes(interval.startTime, intervalEnd, workStart, workEnd);
            }, 0);
            const presentDuringShift = s.firstEntry
                ? overlapMinutes(s.firstEntry, cappedEnd, workStart, workEnd)
                : 0;
            const rawOutsideMinutes = outsideDuringShift;
            const timeInOfficeMinutes = Math.max(0, presentDuringShift - outsideDuringShift);
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
            const dayOff = Boolean(s.firstEntry && arrivalIsDayOff(s.firstEntry));

            return {
                workDate: s.workDate,
                employeeId: s.employeeId,
                employeeNumber: s.employee.employeeNumber,
                employeeName: `${s.employee.firstName} ${s.employee.lastName}`,
                department: s.employee.department,
                position: s.employee.position,
                firstEntry: formatYerevanTime(s.firstEntry),
                lastExit: formatYerevanTime(s.lastExit),
                status: dayOff ? "Day off" : statusLabel(s.currentStatus),
                totalOutsideMinutes: rawOutsideMinutes,
                timeInOfficeMinutes,
                overtimeInOfficeMinutes,
                exitCount: s.exitCount,
                dayOff,
            };
        });

        const filteredSessions = filterPeriodReportRows(rows, {
            employeeId,
            name: filters.name,
        });

        const employees =
            allowedIds != null
                ? await prisma.employee.findMany({
                      where: { status: "ACTIVE", employeeId: { in: allowedIds } },
                  })
                : employeeId
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
        const showDayOff = String(filters.status || "").toLowerCase().replace(/[\s-]+/g, "_") === "day_off";
        const dayOffRows = filteredSessions.filter((row) => row.dayOff);
        const dayOffMissed = notArrivedRows.filter((row) => (row.workDate || "") >= DAY_OFF_STARTS_ON);
        const visibleRows = showNotArrived ? notArrivedRows : filteredSessions;
        const dayOffByEmployee = mergeDayOffSummaries(
            groupDayOffByEmployee(dayOffRows),
            groupNotArrivedByEmployee(dayOffMissed)
        );
        const summary = summarizePeriodReportRows(
            showNotArrived ? notArrivedRows : filteredSessions,
            notArrivedRows,
            [
                ...dayOffRows.map((row) => ({ employeeId: row.employeeId, dayOff: true })),
                ...dayOffMissed.map((row) => ({ employeeId: row.employeeId, dayOff: true })),
            ]
        );

        return {
            from,
            to,
            company: config.companyName,
            generatedAt: new Date().toISOString(),
            filters: {
                employeeId: employeeId || null,
                name: normalizeReportNameQuery(filters.name) ? filters.name?.trim() : null,
                status: showNotArrived ? "not_arrived" : showDayOff ? "day_off" : null,
            },
            summary,
            rows: visibleRows,
            notArrivedRows,
            notArrivedByEmployee,
            dayOffByEmployee,
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
                dayOff: false,
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

function mergeDayOffSummaries(
    late: Array<{
        employeeId: string;
        employeeName: string;
        employeeNumber: string;
        department: string | null;
        position?: string | null;
        dates: string[];
    }>,
    missed: Array<{
        employeeId: string;
        employeeName: string;
        employeeNumber: string;
        department: string | null;
        position?: string | null;
        dates: string[];
    }>
) {
    const map = new Map<
        string,
        {
            employeeId: string;
            employeeName: string;
            employeeNumber: string;
            department: string | null;
            position?: string | null;
            daysDayOff: number;
            dates: string[];
        }
    >();
    const put = (
        item: (typeof late)[number],
        label: string
    ) => {
        const dates = item.dates.map((date) => `${date} ${label}`);
        const existing = map.get(item.employeeId);
        if (!existing) {
            map.set(item.employeeId, {
                employeeId: item.employeeId,
                employeeName: item.employeeName,
                employeeNumber: item.employeeNumber,
                department: item.department,
                position: item.position,
                daysDayOff: dates.length,
                dates,
            });
            return;
        }
        for (const date of dates) {
            if (!existing.dates.includes(date)) existing.dates.push(date);
        }
        existing.daysDayOff = existing.dates.length;
    };
    for (const item of missed) put(item, "не пришёл");
    for (const item of late) put(item, "после 17:30");
    return [...map.values()]
        .map((item) => ({ ...item, dates: [...item.dates].sort() }))
        .sort((a, b) => b.daysDayOff - a.daysDayOff || a.employeeName.localeCompare(b.employeeName));
}

export const reportService = new ReportService();
