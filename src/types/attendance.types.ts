export type EmployeeStatus =
    | "SCHEDULED"
    | "INSIDE_OFFICE"
    | "OUTSIDE_OFFICE"
    | "COMPLETED"
    | "EXCEPTION";

export type AttendanceDirection = "ENTRY" | "EXIT";

export type AttendanceEventType =
    | "NORMAL"
    | "DUPLICATE_ENTRY"
    | "DUPLICATE_EXIT"
    | "UNKNOWN"
    | "MANUAL_CORRECTION"
    | "SYSTEM_CORRECTION";

export interface AttendanceResult {
    late: boolean;
    lateMinutes: number;
}

export interface AttendanceSummary {
    totalAbsenceMinutes: number;
    currentAbsenceMinutes: number;
    exitCount: number;
    currentStatus: EmployeeStatus;
}

export interface LegacyWebhookPayload {
    profile_id?: string;
    device_id: string;
    token: string;
    external_ref?: string | null;
    decision: "enter" | "exit";
    direction?: "in" | "out" | null;
    scanned_at: string;
}

export interface StandardWebhookPayload {
    employeeIdentifier: string;
    timestamp: string;
    direction: "IN" | "OUT" | "ENTRY" | "EXIT";
    deviceId: string;
    webhookId: string;
    source?: string;
}

export interface ApiResponse<T = unknown> {
    success: boolean;
    message: string;
    data?: T;
    errors?: string[];
    timestamp: string;
    requestId: string;
}

export interface DashboardEmployeeRow {
    employeeId: string;
    employeeNumber: string;
    employeeName: string;
    department: string | null;
    position: string | null;
    shiftName: string;
    scheduledStart: string;
    firstEntry: string | null;
    lastExit: string | null;
    currentStatus: string;
    currentAbsenceMinutes: number;
    currentOfficeMinutes: number;
    /** Minutes beyond the daily 60-minute break allowance. */
    totalAbsenceMinutes: number;
    /** All outside minutes, including the allowed break and an open interval. */
    rawOutsideMinutes: number;
    breakAllowanceMinutes: number;
    late: boolean;
    lateMinutes: number;
    exitCount: number;
    lastActivity: string | null;
}

export interface DashboardStatistics {
    employeesScheduled: number;
    employeesPresent: number;
    employeesOutside: number;
    employeesLate: number;
    employeesNotArrived: number;
    completedSessions: number;
}
