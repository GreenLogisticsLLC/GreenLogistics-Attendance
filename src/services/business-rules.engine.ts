import { config } from "../config/env.js";
import {
    combineDateAndTime,
    getWorkDateString,
    parseTimeToMinutes,
} from "../utils/helpers.js";
import type { AttendanceResult, LegacyWebhookPayload } from "../types/attendance.types.js";

interface ShiftInfo {
    startTime: string;
    endTime: string;
    gracePeriodMinutes: number;
    crossMidnight: boolean;
}

export class BusinessRulesEngine {
    determineWorkDate(eventTime: Date, shift: ShiftInfo): string {
        const tz = config.timezone;
        const eventMinutes = this.getLocalMinutes(eventTime, tz);
        const startMinutes = parseTimeToMinutes(shift.startTime);

        if (shift.crossMidnight && eventMinutes < startMinutes) {
            const yesterday = new Date(eventTime);
            yesterday.setDate(yesterday.getDate() - 1);
            return getWorkDateString(yesterday, tz);
        }

        return getWorkDateString(eventTime, tz);
    }

    calculateScheduledTimes(workDate: string, shift: ShiftInfo) {
        const scheduledStart = combineDateAndTime(workDate, shift.startTime);
        let scheduledEnd = combineDateAndTime(workDate, shift.endTime);

        if (
            shift.crossMidnight ||
            parseTimeToMinutes(shift.endTime) <= parseTimeToMinutes(shift.startTime)
        ) {
            scheduledEnd = new Date(scheduledEnd);
            scheduledEnd.setDate(scheduledEnd.getDate() + 1);
        }

        return { scheduledStart, scheduledEnd };
    }

    calculateLateStatus(
        firstEntry: Date,
        scheduledStart: Date,
        gracePeriodMinutes: number
    ): AttendanceResult {
        const graceEnd = new Date(scheduledStart);
        graceEnd.setMinutes(graceEnd.getMinutes() + gracePeriodMinutes);

        if (firstEntry <= graceEnd) {
            return { late: false, lateMinutes: 0 };
        }

        const lateMinutes = Math.floor(
            (firstEntry.getTime() - graceEnd.getTime()) / 60000
        );
        return { late: true, lateMinutes: Math.max(1, lateMinutes) };
    }

    mapLegacyDirection(payload: LegacyWebhookPayload): "ENTRY" | "EXIT" {
        if (payload.direction) {
            const d = payload.direction.toLowerCase();
            if (d === "in" || d === "entry") return "ENTRY";
            if (d === "out" || d === "exit") return "EXIT";
        }
        return this.mapDecisionToDirection(payload.decision);
    }

    mapDecisionToDirection(decision: string): "ENTRY" | "EXIT" {
        const normalized = (decision || "").toLowerCase().trim();
        if (
            normalized === "enter" ||
            normalized === "in" ||
            normalized === "entry" ||
            normalized.startsWith("ent")
        ) {
            return "ENTRY";
        }
        if (
            normalized === "exit" ||
            normalized === "out" ||
            normalized === "leave" ||
            normalized.startsWith("ex")
        ) {
            return "EXIT";
        }
        // Ambiguous decisions (granted / open / allow / empty) must NOT mark EXIT —
        // that was wiping In Office brokers from the assignment queue.
        return "ENTRY";
    }

    mapStandardDirection(direction: string): "ENTRY" | "EXIT" {
        const normalized = direction.toUpperCase();
        if (normalized === "IN" || normalized === "ENTRY") return "ENTRY";
        return "EXIT";
    }

    private getLocalMinutes(date: Date, timezone: string): number {
        const parts = date.toLocaleString("en-GB", {
            timeZone: timezone,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });
        const [h, m] = parts.split(":").map(Number);
        return h * 60 + m;
    }
}

export const businessRulesEngine = new BusinessRulesEngine();
