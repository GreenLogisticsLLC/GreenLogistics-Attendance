import { randomUUID } from "crypto";
import os from "os";

export function getLocalNetworkIp(): string | null {
    const candidates: string[] = [];
    for (const nets of Object.values(os.networkInterfaces())) {
        for (const net of nets ?? []) {
            const isV4 = String(net.family) === "IPv4" || String(net.family) === "4";
            if (!isV4 || net.internal) continue;
            candidates.push(net.address);
        }
    }
    return (
        candidates.find((ip) => ip.startsWith("192.168.")) ??
        candidates.find((ip) => ip.startsWith("10.")) ??
        candidates.find((ip) => ip.startsWith("172.")) ??
        candidates[0] ??
        null
    );
}

export function getAllNetworkIps(): string[] {
    const ips: string[] = [];
    for (const nets of Object.values(os.networkInterfaces())) {
        for (const net of nets ?? []) {
            const isV4 = String(net.family) === "IPv4" || String(net.family) === "4";
            if (isV4 && !net.internal) ips.push(net.address);
        }
    }
    return ips;
}

export function getWebhookUrls(port: number) {
    const path = `/api/v1/webhook/attendance`;
    const local = `http://localhost:${port}${path}`;
    const ip = getLocalNetworkIp();
    const network = ip ? `http://${ip}:${port}${path}` : null;
    return { local, network, recommended: network ?? local };
}

export function generateRequestId(): string {
    return randomUUID();
}

export function apiResponse<T>(
    success: boolean,
    message: string,
    data?: T,
    errors?: string[]
) {
    return {
        success,
        message,
        data,
        errors,
        timestamp: new Date().toISOString(),
        requestId: generateRequestId(),
    };
}

export function normalizeCardToken(token: string): string {
    return token
        .toLowerCase()
        .trim()
        .replace(/^0x_/i, "")
        .replace(/0x/gi, "")
        .replace(/[\s_-]/g, "");
}

export function buildWebhookId(payload: {
    profile_id?: string;
    device_id: string;
    token: string;
    scanned_at: string;
    decision: string;
}): string {
    return [
        payload.profile_id || "default",
        payload.device_id,
        normalizeCardToken(payload.token),
        payload.scanned_at,
        payload.decision,
    ].join("|");
}

export function parseTimeToMinutes(time: string): number {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
}

export function formatMinutes(minutes: number): string {
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function officeTimeZone(): string {
    return process.env.TIMEZONE || "America/Los_Angeles";
}

/**
 * Access-control stamps historically land ~1h ahead of LA wall clocks during PDT
 * (partner examples use a fixed +04:00 offset). Shift display / late checks back by
 * one hour so First Entry and the 17:15 late cutoff match the office clock.
 */
export const ATTENDANCE_DISPLAY_OFFSET_MS = 60 * 60 * 1000;

/** Map a stored access-control instant onto the office wall clock. */
export function toAttendanceClock(date: Date | string): Date {
    const raw = typeof date === "string" ? new Date(date) : date;
    return new Date(raw.getTime() - ATTENDANCE_DISPLAY_OFFSET_MS);
}

export function formatDateTime(date: Date | string | null): string | null {
    if (!date) return null;
    const d = typeof date === "string" ? new Date(date) : date;
    return d.toLocaleString("en-GB", {
        timeZone: officeTimeZone(),
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    });
}

/** HH:MM:SS only in office TZ, corrected −1h for attendance event clocks. */
export function formatTime(date: Date | string | null): string | null {
    if (!date) return null;
    const raw = typeof date === "string" ? new Date(date) : date;
    if (Number.isNaN(raw.getTime())) return null;
    const d = toAttendanceClock(raw);
    return d.toLocaleString("en-GB", {
        timeZone: officeTimeZone(),
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    });
}

export function getWorkDateString(date: Date, timezone: string): string {
    return date.toLocaleDateString("en-CA", { timeZone: timezone });
}

export const ATTENDANCE_DAY_START = "17:00";
export const ATTENDANCE_DAY_END = "02:00";
/** Countable work hours end — Total Outside stops here; leaving after this is going home. */
export const ATTENDANCE_WORK_END = "01:00";
/** Arrive by scheduledStart + this many minutes; after that = late. */
export const ATTENDANCE_GRACE_MINUTES = 15;
export const ATTENDANCE_BREAK_ALLOWANCE_MINUTES = 60;

function zonedParts(date: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((part) => part.type === type)?.value || 0);
    return {
        year: value("year"),
        month: value("month"),
        day: value("day"),
        hour: value("hour"),
        minute: value("minute"),
        second: value("second"),
    };
}

export function addDaysToDateString(workDate: string, days: number): string {
    const [year, month, day] = workDate.split("-").map(Number);
    const shifted = new Date(Date.UTC(year, month - 1, day + days));
    return shifted.toISOString().slice(0, 10);
}

/** Convert a wall-clock time in an IANA timezone to the corresponding UTC instant. */
export function zonedDateTime(workDate: string, time: string, timezone: string): Date {
    const [year, month, day] = workDate.split("-").map(Number);
    const [hour, minute] = time.split(":").map(Number);
    const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
    let candidate = new Date(targetAsUtc);

    // Two passes handle normal offsets and DST boundaries without another dependency.
    for (let i = 0; i < 2; i += 1) {
        const actual = zonedParts(candidate, timezone);
        const actualAsUtc = Date.UTC(
            actual.year,
            actual.month - 1,
            actual.day,
            actual.hour,
            actual.minute,
            actual.second
        );
        candidate = new Date(candidate.getTime() + (targetAsUtc - actualAsUtc));
    }
    return candidate;
}

/**
 * Attendance day is named for the date on which its 17:00 shift starts.
 * 00:00–01:59 belongs to the previous date; from 02:00 the next board is clean.
 */
export function getAttendanceWorkDate(date: Date, timezone: string): string {
    const local = zonedParts(date, timezone);
    const localDate = [
        String(local.year).padStart(4, "0"),
        String(local.month).padStart(2, "0"),
        String(local.day).padStart(2, "0"),
    ].join("-");
    return local.hour < 2 ? addDaysToDateString(localDate, -1) : localDate;
}

export function getAttendanceDayBounds(workDate: string, timezone: string) {
    return {
        scheduledStart: zonedDateTime(workDate, ATTENDANCE_DAY_START, timezone),
        scheduledEnd: zonedDateTime(
            addDaysToDateString(workDate, 1),
            ATTENDANCE_DAY_END,
            timezone
        ),
    };
}

/**
 * Queue clock. 17:00–01:00 Yerevan is the office day.
 * 01:00–16:59 Yerevan every Broker and Team Lead is in the queue.
 */
export const ASSIGNMENT_TIMEZONE = "Asia/Yerevan";

/** First office day that counts a late arrival as Day off. */
export const DAY_OFF_STARTS_ON = "2026-11-05";

function yerevanDateString(date: Date): string {
    const local = zonedParts(date, ASSIGNMENT_TIMEZONE);
    return [
        String(local.year).padStart(4, "0"),
        String(local.month).padStart(2, "0"),
        String(local.day).padStart(2, "0"),
    ].join("-");
}

/**
 * Office shift that is open at this instant, named by the Yerevan date of its 17:00 start.
 * 01:00–16:59 is between shifts.
 */
export function officeShiftDate(instant: Date): string | null {
    const local = zonedParts(instant, ASSIGNMENT_TIMEZONE);
    const ymd = yerevanDateString(instant);
    const minutes = local.hour * 60 + local.minute;
    if (minutes >= 17 * 60) return ymd;
    if (minutes < 60) return addDaysToDateString(ymd, -1);
    return null;
}

/** HH:MM:SS in Yerevan, from the real instant. No Los Angeles shift. */
export function formatYerevanTime(date: Date | string | null): string | null {
    if (!date) return null;
    const raw = typeof date === "string" ? new Date(date) : date;
    if (Number.isNaN(raw.getTime())) return null;
    return raw.toLocaleString("en-GB", {
        timeZone: ASSIGNMENT_TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    });
}

/** First arrival after 17:30 Yerevan. Reports use every date; the queue starts 5 Nov 2026. */
export function arrivedAfterDayOffCutoff(firstEntry: Date): boolean {
    const shift = officeShiftDate(firstEntry);
    const day = shift ?? yerevanDateString(firstEntry);
    const cutoff = zonedDateTime(day, "17:30", ASSIGNMENT_TIMEZONE);
    return firstEntry.getTime() > cutoff.getTime();
}

/** Queue rule: after 17:30 Yerevan on a shift that starts 5 Nov 2026 or later. */
export function arrivalIsDayOff(firstEntry: Date): boolean {
    const shift = officeShiftDate(firstEntry);
    if (!shift || shift < DAY_OFF_STARTS_ON) return false;
    return arrivedAfterDayOffCutoff(firstEntry);
}

/** Employees whose first entry this office shift was after 17:00 Yerevan. */
export function dayOffEmployeeIdsFromRows(
    rows: Array<{ employeeId: string; firstEntry: Date | null }>,
    now: Date
): string[] {
    const shift = officeShiftDate(now);
    if (!shift || shift < DAY_OFF_STARTS_ON) return [];
    const start = zonedDateTime(shift, "17:00", ASSIGNMENT_TIMEZONE);
    const lateLine = zonedDateTime(shift, "17:30", ASSIGNMENT_TIMEZONE);
    const end = zonedDateTime(addDaysToDateString(shift, 1), "01:00", ASSIGNMENT_TIMEZONE);
    const earliest = new Map<string, Date>();
    for (const row of rows) {
        if (!row.firstEntry) continue;
        if (row.firstEntry < start || row.firstEntry >= end) continue;
        const prev = earliest.get(row.employeeId);
        if (!prev || row.firstEntry < prev) earliest.set(row.employeeId, row.firstEntry);
    }
    const ids: string[] = [];
    for (const [employeeId, at] of earliest) {
        if (at.getTime() > lateLine.getTime()) ids.push(employeeId);
    }
    return ids;
}

/**
 * The handoff clock, not the email's own timestamp.
 * A shipment given out at 05:00 Yerevan is a night shipment even when the
 * uShip mail was received during the 17:00–01:00 office shift.
 */
export function assignmentWasAfterHours(
    input: {
        assignedAt?: Date | string | null;
        receivedAt?: Date | string | null;
        createdAt?: Date | string | null;
    },
    timezone: string
): boolean {
    const at = input.assignedAt || input.receivedAt || input.createdAt;
    if (!at) return false;
    const date = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(date.getTime())) return false;
    return isAfterHoursAssignment(date, timezone);
}

/**
 * After 01:00 until the next 17:00 on the given clock.
 * New shipments then go to every Broker and Team Lead, not only people In Office.
 */
export function isAfterHoursAssignment(date: Date, timezone: string): boolean {
    const local = zonedParts(date, timezone);
    const minutes = local.hour * 60 + local.minute;
    const workEnd = 1 * 60;
    const workStart = 17 * 60;
    return minutes >= workEnd && minutes < workStart;
}

/**
 * Dashboard "today" for shipments: 01:00 Asia/Yerevan → next 01:00.
 * Before 01:00 still belongs to the previous shipment day.
 */
export function startOfShipmentDay(
    now: Date = new Date(),
    timezone: string = ASSIGNMENT_TIMEZONE
): Date {
    const local = zonedParts(now, timezone);
    const ymd = [
        String(local.year).padStart(4, "0"),
        String(local.month).padStart(2, "0"),
        String(local.day).padStart(2, "0"),
    ].join("-");
    const day = local.hour < 1 ? addDaysToDateString(ymd, -1) : ymd;
    return zonedDateTime(day, "01:00", timezone);
}

/** Prisma filter: email arrival time, or createdAt when receivedAt is missing. */
export function arrivedSince(since: Date) {
    return {
        OR: [
            { receivedAt: { gte: since } },
            { AND: [{ receivedAt: null }, { createdAt: { gte: since } }] },
        ],
    };
}

/** After 01:00 the whole Broker and Team Lead roster is in the circle. */
export function chooseAssignmentPool(input: {
    afterHours: boolean;
    linkedCount: number;
    inOfficeCount: number;
}): "after_hours" | "in_office" | "none" {
    if (input.afterHours && input.linkedCount > 0) return "after_hours";
    if (input.inOfficeCount > 0) return "in_office";
    return "none";
}

/** Night shipment stays put until this instant, then check-in starts the Accept clock. */
export const NIGHT_HOLD_UNTIL_OFFICE = new Date("2099-01-01T00:00:00.000Z");

/**
 * Daytime arrivals: 15 minutes to Accept.
 * Night arrivals (01:00–16:59): always hold until check-in arms a 30-minute
 * window. Night-shift brokers who are already In Office must keep New Shipments
 * — a short 30-minute timer at handoff emptied Andy/Maddy's New list overnight
 * while sleeping brokers (on hold) still saw theirs in the morning.
 * `assigneeInOffice` is kept for callers; it does not shorten the night hold.
 */
export function nightAcceptanceDeadline(input: {
    arrivedAt: Date;
    now: Date;
    assigneeInOffice: boolean;
    timezone: string;
}): Date {
    if (!isAfterHoursAssignment(input.arrivedAt, input.timezone)) {
        return new Date(input.now.getTime() + 15 * 60_000);
    }
    return NIGHT_HOLD_UNTIL_OFFICE;
}

/** Paid/countable work window: 17:00 → 01:00 next day. */
export function getAttendanceWorkHoursBounds(workDate: string, timezone: string) {
    return {
        workStart: zonedDateTime(workDate, ATTENDANCE_DAY_START, timezone),
        workEnd: zonedDateTime(
            addDaysToDateString(workDate, 1),
            ATTENDANCE_WORK_END,
            timezone
        ),
    };
}

export function overlapMinutes(
    start: Date,
    end: Date,
    windowStart: Date,
    windowEnd: Date
): number {
    const from = start > windowStart ? start : windowStart;
    const to = end < windowEnd ? end : windowEnd;
    return to > from ? diffMinutes(from, to) : 0;
}

export type OutsideInterval = {
    startTime: Date;
    endTime?: Date | null;
};

/**
 * Total Outside = every out-of-office interval until 01:00 (going home).
 * Morning/day breaks count; time after 01:00 does not.
 * `workStart` is kept for callers; clipping is only at `workEnd`.
 * `intervals` and `now` must already be on the office wall clock.
 */
export function sumWorkHoursOutsideMinutes(
    intervals: OutsideInterval[],
    now: Date,
    _workStart: Date,
    workEnd: Date
): number {
    return intervals.reduce((sum, interval) => {
        const rawEnd = interval.endTime ?? now;
        const end = rawEnd < workEnd ? rawEnd : workEnd;
        return end > interval.startTime ? sum + diffMinutes(interval.startTime, end) : sum;
    }, 0);
}

/** Map a stored access-control interval onto the office wall clock. */
export function toAttendanceInterval(interval: OutsideInterval): OutsideInterval {
    return {
        startTime: toAttendanceClock(interval.startTime),
        endTime: interval.endTime ? toAttendanceClock(interval.endTime) : null,
    };
}

/**
 * Total Outside from stored access-control stamps.
 * Event stamps AND `now` are mapped onto the office clock (the same clock as
 * First Entry / Last Activity) so a break from 08:12 to 08:33 is 21 minutes,
 * not 1h 21m against unshifted wall time.
 */
export function sumAttendanceOutsideMinutes(
    intervals: OutsideInterval[],
    now: Date,
    workStart: Date,
    workEnd: Date
): number {
    return sumWorkHoursOutsideMinutes(
        intervals.map(toAttendanceInterval),
        toAttendanceClock(now),
        workStart,
        workEnd
    );
}

/**
 * Live "Outside Now": office-clock elapsed time since the exit, frozen at 01:00.
 * Both ends use the attendance clock so the column matches Last Activity vs the header.
 */
export function currentOutsideNowMinutes(
    startTime: Date,
    now: Date,
    workEnd: Date
): number {
    const start = toAttendanceClock(startTime);
    const nowClock = toAttendanceClock(now);
    const end = nowClock < workEnd ? nowClock : workEnd;
    return end > start ? diffMinutes(start, end) : 0;
}

/** Access-control EXIT at/after 01:00 office clock = going home, not a break. */
export function isGoingHomeExit(eventTime: Date, workEnd: Date): boolean {
    return toAttendanceClock(eventTime) >= workEnd;
}

export function excessOutsideMinutes(totalOutsideMinutes: number): number {
    return Math.max(0, totalOutsideMinutes - ATTENDANCE_BREAK_ALLOWANCE_MINUTES);
}

export function combineDateAndTime(workDate: string, timeStr: string): Date {
    const [hours, minutes] = timeStr.split(":").map(Number);
    const [year, month, day] = workDate.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));
}

export function diffMinutes(start: Date, end: Date): number {
    return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60000));
}
