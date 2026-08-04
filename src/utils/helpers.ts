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

export function formatDateTime(date: Date | string | null): string | null {
    if (!date) return null;
    const d = typeof date === "string" ? new Date(date) : date;
    return d.toLocaleString("en-GB", {
        timeZone: process.env.TIMEZONE || "Asia/Yerevan",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
}

export function getWorkDateString(date: Date, timezone: string): string {
    return date.toLocaleDateString("en-CA", { timeZone: timezone });
}

export const ATTENDANCE_DAY_START = "17:00";
export const ATTENDANCE_DAY_END = "02:00";
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
