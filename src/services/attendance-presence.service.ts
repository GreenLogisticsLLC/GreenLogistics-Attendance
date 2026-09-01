import { config } from "../config/env.js";
import {
    addDaysToDateString,
    getAttendanceDayBounds,
    getAttendanceWorkDate,
} from "../utils/helpers.js";
import { attendanceSessionRepository } from "../repositories/attendance-session.repository.js";

type PresenceSession = Awaited<
    ReturnType<typeof attendanceSessionRepository.findByEmployeeAndWorkDate>
>;

/**
 * Same presence rules as the Attendance Dashboard:
 * - Prefer today's attendance-day session
 * - Before today's 17:00 start, carry over yesterday's INSIDE_OFFICE overtime
 *
 * Assignment and CRM must use this — not a raw 48h lastActivity scan —
 * so "In Office" on the board matches who can receive shipments.
 */
export async function getEmployeePresenceSession(employeeId: string) {
    const map = await getEmployeePresenceSessionsMap([employeeId]);
    return map.get(employeeId) ?? null;
}

/** Batch presence lookup — one query per work date instead of N round-trips. */
export async function getEmployeePresenceSessionsMap(
    employeeIds: string[]
): Promise<Map<string, PresenceSession>> {
    const uniqueIds = [...new Set(employeeIds.filter(Boolean))];
    const result = new Map<string, PresenceSession>();
    if (!uniqueIds.length) return result;

    const now = new Date();
    const workDate = getAttendanceWorkDate(now, config.timezone);
    const bounds = getAttendanceDayBounds(workDate, config.timezone);
    const yesterday = addDaysToDateString(workDate, -1);
    const carryOver = now < bounds.scheduledStart;

    const [todaySessions, yesterdaySessions] = await Promise.all([
        attendanceSessionRepository.findByEmployeesAndWorkDate(uniqueIds, workDate),
        carryOver
            ? attendanceSessionRepository.findByEmployeesAndWorkDate(uniqueIds, yesterday)
            : Promise.resolve([]),
    ]);

    const todayByEmployee = new Map(todaySessions.map((s) => [s.employeeId, s]));
    const yesterdayByEmployee = new Map(yesterdaySessions.map((s) => [s.employeeId, s]));

    for (const employeeId of uniqueIds) {
        let session = todayByEmployee.get(employeeId) ?? null;
        if (!session && carryOver) {
            const previous = yesterdayByEmployee.get(employeeId);
            if (
                previous?.currentStatus === "INSIDE_OFFICE" &&
                now >= previous.scheduledEnd
            ) {
                session = previous;
            }
        }
        result.set(employeeId, session);
    }

    return result;
}

export async function getInOfficeEmployeeIds(employeeIds: string[]): Promise<Set<string>> {
    const sessions = await getEmployeePresenceSessionsMap(employeeIds);
    const inOffice = new Set<string>();
    for (const [employeeId, session] of sessions) {
        if (session?.currentStatus === "INSIDE_OFFICE") {
            inOffice.add(employeeId);
        }
    }
    return inOffice;
}

export async function isEmployeeInOffice(employeeId: string): Promise<boolean> {
    const inOffice = await getInOfficeEmployeeIds([employeeId]);
    return inOffice.has(employeeId);
}
