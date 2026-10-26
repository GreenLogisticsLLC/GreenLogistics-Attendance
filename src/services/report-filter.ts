export const REPORT_STATUS_NOT_ARRIVED = "not_arrived";

export interface PeriodReportFilters {
    employeeId?: string;
    name?: string;
    status?: string;
}

export type ReportFilterableRow = {
    employeeId: string;
    employeeName: string;
    employeeNumber: string;
    department: string | null;
    position?: string | null;
    firstEntry?: string | null;
    status?: string;
    workDate?: string;
};

export interface PeriodReportSummary {
    totalSessions: number;
    daysWithEntry: number;
    totalOutsideMinutes: number;
    totalInOfficeMinutes: number;
    totalOvertimeMinutes: number;
    daysNotArrived: number;
    employeesNotArrived: number;
}

export interface NotArrivedEmployeeSummary {
    employeeId: string;
    employeeName: string;
    employeeNumber: string;
    department: string | null;
    position?: string | null;
    daysNotArrived: number;
    dates: string[];
}

export function normalizeReportNameQuery(name?: string | null): string {
    return (name || "").trim().toLowerCase();
}

export function normalizeReportStatus(status?: string | null): string {
    return (status || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function isNotArrivedStatus(status?: string | null): boolean {
    const st = normalizeReportStatus(status);
    return st === REPORT_STATUS_NOT_ARRIVED || st === "scheduled";
}

export function isNotArrivedRow(row: {
    firstEntry?: string | null;
    status?: string | null;
}): boolean {
    if (!row.firstEntry) return true;
    return isNotArrivedStatus(row.status);
}

export function listDateStrings(from: string, to: string): string[] {
    if (!from || !to || from > to) return [];
    const dates: string[] = [];
    let cur = from;
    while (cur <= to) {
        dates.push(cur);
        const [year, month, day] = cur.split("-").map(Number);
        cur = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
        if (dates.length > 400) break;
    }
    return dates;
}

/** Last work date that can count as "did not arrive" (never future; skip today before shift start). */
export function lastCountableWorkDate(
    to: string,
    todayWorkDate: string,
    currentShiftStarted: boolean
): string | null {
    let last = to < todayWorkDate ? to : todayWorkDate;
    if (!currentShiftStarted && last === todayWorkDate) {
        const [year, month, day] = todayWorkDate.split("-").map(Number);
        last = new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
    }
    return last;
}

export function rowMatchesReportFilters(
    row: ReportFilterableRow,
    filters: PeriodReportFilters = {}
): boolean {
    if (filters.employeeId && row.employeeId !== filters.employeeId) return false;
    if (isNotArrivedStatus(filters.status) && !isNotArrivedRow(row)) return false;
    const q = normalizeReportNameQuery(filters.name);
    if (!q) return true;
    const hay = [
        row.employeeName,
        row.employeeNumber,
        row.department || "",
        row.position || "",
    ]
        .join(" ")
        .toLowerCase();
    return q.split(/\s+/).filter(Boolean).every((token) => hay.includes(token));
}

export function filterPeriodReportRows<T extends ReportFilterableRow>(
    rows: T[],
    filters: PeriodReportFilters = {}
): T[] {
    const hasPerson = Boolean(filters.employeeId || normalizeReportNameQuery(filters.name));
    const hasStatus = isNotArrivedStatus(filters.status);
    if (!hasPerson && !hasStatus) return rows;
    return rows.filter((row) => rowMatchesReportFilters(row, filters));
}

export function groupNotArrivedByEmployee<T extends ReportFilterableRow>(
    rows: T[]
): NotArrivedEmployeeSummary[] {
    const map = new Map<string, NotArrivedEmployeeSummary>();
    for (const row of rows) {
        if (!isNotArrivedRow(row)) continue;
        const existing = map.get(row.employeeId);
        const date = row.workDate || "";
        if (existing) {
            if (date && !existing.dates.includes(date)) existing.dates.push(date);
            existing.daysNotArrived = existing.dates.length;
            continue;
        }
        map.set(row.employeeId, {
            employeeId: row.employeeId,
            employeeName: row.employeeName,
            employeeNumber: row.employeeNumber,
            department: row.department,
            position: row.position,
            daysNotArrived: date ? 1 : 0,
            dates: date ? [date] : [],
        });
    }
    return [...map.values()]
        .map((item) => ({
            ...item,
            dates: [...item.dates].sort(),
            daysNotArrived: item.dates.length,
        }))
        .sort((a, b) => {
            const days = b.daysNotArrived - a.daysNotArrived;
            if (days !== 0) return days;
            return a.employeeName.localeCompare(b.employeeName, undefined, { sensitivity: "base" });
        });
}

export function summarizePeriodReportRows(
    rows: Array<{
        firstEntry: string | null;
        totalOutsideMinutes: number;
        timeInOfficeMinutes: number;
        overtimeInOfficeMinutes: number;
    }>,
    notArrivedRows: Array<{ employeeId: string }> = []
): PeriodReportSummary {
    const absentIds = new Set(notArrivedRows.map((r) => r.employeeId));
    return {
        totalSessions: rows.length,
        daysWithEntry: rows.filter((r) => r.firstEntry).length,
        totalOutsideMinutes: rows.reduce((s, r) => s + r.totalOutsideMinutes, 0),
        totalInOfficeMinutes: rows.reduce((s, r) => s + r.timeInOfficeMinutes, 0),
        totalOvertimeMinutes: rows.reduce((s, r) => s + r.overtimeInOfficeMinutes, 0),
        daysNotArrived: notArrivedRows.length,
        employeesNotArrived: absentIds.size,
    };
}
