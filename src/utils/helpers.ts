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

export function combineDateAndTime(workDate: string, timeStr: string): Date {
    const [hours, minutes] = timeStr.split(":").map(Number);
    const [year, month, day] = workDate.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));
}

export function diffMinutes(start: Date, end: Date): number {
    return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60000));
}
