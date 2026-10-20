export interface PeriodReportFilters {
    employeeId?: string;
    name?: string;
}

export type ReportFilterableRow = {
    employeeId: string;
    employeeName: string;
    employeeNumber: string;
    department: string | null;
    position?: string | null;
};

export interface PeriodReportSummary {
    totalSessions: number;
    daysWithEntry: number;
    totalOutsideMinutes: number;
    totalInOfficeMinutes: number;
    totalOvertimeMinutes: number;
}

export function normalizeReportNameQuery(name?: string | null): string {
    return (name || "").trim().toLowerCase();
}

export function rowMatchesReportFilters(
    row: ReportFilterableRow,
    filters: PeriodReportFilters = {}
): boolean {
    if (filters.employeeId && row.employeeId !== filters.employeeId) return false;
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
    return hay.includes(q);
}

export function filterPeriodReportRows<T extends ReportFilterableRow>(
    rows: T[],
    filters: PeriodReportFilters = {}
): T[] {
    if (!filters.employeeId && !normalizeReportNameQuery(filters.name)) return rows;
    return rows.filter((row) => rowMatchesReportFilters(row, filters));
}

export function summarizePeriodReportRows(
    rows: Array<{
        firstEntry: string | null;
        totalOutsideMinutes: number;
        timeInOfficeMinutes: number;
        overtimeInOfficeMinutes: number;
    }>
): PeriodReportSummary {
    return {
        totalSessions: rows.length,
        daysWithEntry: rows.filter((r) => r.firstEntry).length,
        totalOutsideMinutes: rows.reduce((s, r) => s + r.totalOutsideMinutes, 0),
        totalInOfficeMinutes: rows.reduce((s, r) => s + r.timeInOfficeMinutes, 0),
        totalOvertimeMinutes: rows.reduce((s, r) => s + r.overtimeInOfficeMinutes, 0),
    };
}
