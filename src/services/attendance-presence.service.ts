import { config } from "../config/env.js";
import {
    addDaysToDateString,
    getAttendanceDayBounds,
    getAttendanceWorkDate,
} from "../utils/helpers.js";
import { attendanceSessionRepository } from "../repositories/attendance-session.repository.js";

/**
 * Same presence rules as the Attendance Dashboard:
 * - Prefer today's attendance-day session
 * - Before today's 17:00 start, carry over yesterday's INSIDE_OFFICE overtime
 *
 * Assignment and CRM must use this — not a raw 48h lastActivity scan —
 * so "In Office" on the board matches who can receive shipments.
 */
export async function getEmployeePresenceSession(employeeId: string) {
    const now = new Date();
    const workDate = getAttendanceWorkDate(now, config.timezone);
    const bounds = getAttendanceDayBounds(workDate, config.timezone);

    let session = await attendanceSessionRepository.findByEmployeeAndWorkDate(
        employeeId,
        workDate
    );

    if (!session && now < bounds.scheduledStart) {
        const previous = await attendanceSessionRepository.findByEmployeeAndWorkDate(
            employeeId,
            addDaysToDateString(workDate, -1)
        );
        if (
            previous?.currentStatus === "INSIDE_OFFICE" &&
            now >= previous.scheduledEnd
        ) {
            session = previous;
        }
    }

    return session;
}

export async function isEmployeeInOffice(employeeId: string): Promise<boolean> {
    const session = await getEmployeePresenceSession(employeeId);
    return session?.currentStatus === "INSIDE_OFFICE";
}
