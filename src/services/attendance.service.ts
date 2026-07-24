import { prisma } from "../config/database.js";
import { config } from "../config/env.js";
import { diffMinutes, getWorkDateString, combineDateAndTime } from "../utils/helpers.js";
import { employeeRepository } from "../repositories/employee.repository.js";
import { attendanceSessionRepository } from "../repositories/attendance-session.repository.js";
import { attendanceEventRepository } from "../repositories/attendance-event.repository.js";
import type { AttendanceEventType, EmployeeStatus } from "../types/attendance.types.js";

interface ProcessEventInput {
    employeeId: string;
    eventTime: Date;
    direction: "ENTRY" | "EXIT";
    deviceId: string;
    webhookId: string;
    source?: string;
}

/**
 * Presence follows the webhook direction only:
 * in / ENTRY → INSIDE_OFFICE
 * out / EXIT → OUTSIDE_OFFICE
 * No toggle relative to previous status. Shift schedules are not used for status.
 */
export class AttendanceService {
    private calendarWorkDate(eventTime: Date): string {
        return getWorkDateString(eventTime, config.timezone);
    }

    private dayBounds(workDate: string) {
        return {
            scheduledStart: combineDateAndTime(workDate, "00:00"),
            scheduledEnd: combineDateAndTime(workDate, "23:59"),
        };
    }

    async processEvent(input: ProcessEventInput) {
        const employee = await employeeRepository.findById(input.employeeId);
        if (!employee) {
            throw new Error("Employee not found");
        }

        // Prefer the latest open presence session so shift schedules cannot split In/Out.
        let session = await attendanceSessionRepository.findRecentActiveSession(employee.employeeId);

        const workDate = this.calendarWorkDate(input.eventTime);
        const { scheduledStart, scheduledEnd } = this.dayBounds(workDate);

        if (!session) {
            session = await attendanceSessionRepository.findByEmployeeAndWorkDate(
                employee.employeeId,
                workDate
            );
        }

        if (!session) {
            const shiftId = employee.shiftId;
            if (!shiftId) {
                throw new Error("Employee has no shift assigned — cannot create session");
            }
            await attendanceSessionRepository.create({
                employeeId: employee.employeeId,
                shiftId,
                workDate,
                scheduledStart,
                scheduledEnd,
            });
            session = await attendanceSessionRepository.findByEmployeeAndWorkDate(
                employee.employeeId,
                workDate
            );
        }

        if (!session) {
            throw new Error("Failed to create attendance session");
        }

        const activeSession = session;
        const currentStatus = activeSession.currentStatus as EmployeeStatus;
        // Use reader-reported direction only — never invert or toggle from prior status.
        const direction = input.direction;

        let eventType: AttendanceEventType = "NORMAL";

        if (direction === "ENTRY") {
            if (currentStatus === "INSIDE_OFFICE") {
                eventType = "DUPLICATE_ENTRY";
            }
        } else if (direction === "EXIT") {
            if (currentStatus === "SCHEDULED") {
                eventType = "UNKNOWN";
            } else if (currentStatus !== "INSIDE_OFFICE") {
                eventType = "DUPLICATE_EXIT";
            }
        }

        const event = await attendanceEventRepository.create({
            sessionId: activeSession.sessionId,
            employeeId: employee.employeeId,
            eventTime: input.eventTime,
            direction,
            eventType,
            deviceId: input.deviceId,
            webhookId: input.webhookId,
            source: input.source || "ACCESS_CONTROL",
        });

        if (eventType === "DUPLICATE_ENTRY" || eventType === "DUPLICATE_EXIT") {
            await this.createNotification(
                employee.employeeId,
                "DUPLICATE_EVENT",
                "MEDIUM",
                `Duplicate scan for ${employee.firstName} ${employee.lastName}`
            );
            return { event, session: activeSession, duplicate: true };
        }

        const updates: Record<string, unknown> = {
            lastActivity: input.eventTime,
            updatedAt: new Date(),
        };

        if (direction === "ENTRY") {
            updates.currentStatus = "INSIDE_OFFICE";

            if (!activeSession.firstEntry) {
                updates.firstEntry = input.eventTime;
                // Presence is card-driven — do not mark late from shift schedules.
                updates.late = false;
                updates.lateMinutes = 0;
            }

            const openInterval = await prisma.absenceInterval.findFirst({
                where: { sessionId: activeSession.sessionId, endTime: null },
                orderBy: { startTime: "desc" },
            });

            if (openInterval) {
                const duration = diffMinutes(openInterval.startTime, input.eventTime);
                await prisma.absenceInterval.update({
                    where: { intervalId: openInterval.intervalId },
                    data: {
                        returnEventId: event.eventId,
                        endTime: input.eventTime,
                        durationMinutes: duration,
                    },
                });

                const totalAbsence = await this.sumAbsenceMinutes(activeSession.sessionId);
                updates.totalAbsenceMinutes = totalAbsence;
            }
        } else {
            // Card exit → Out of office (not shift-based completion)
            updates.currentStatus = "OUTSIDE_OFFICE";
            updates.lastExit = input.eventTime;
            updates.exitCount = activeSession.exitCount + 1;

            await prisma.absenceInterval.create({
                data: {
                    sessionId: activeSession.sessionId,
                    exitEventId: event.eventId,
                    startTime: input.eventTime,
                },
            });
        }

        const updatedSession = await attendanceSessionRepository.update(
            activeSession.sessionId,
            updates
        );

        return { event, session: updatedSession, duplicate: false, direction };
    }

    async markEmployeeLeft(employeeId: string) {
        const employee = await employeeRepository.findById(employeeId);
        if (!employee) {
            throw new Error("Employee not found");
        }

        const now = new Date();
        let session = await attendanceSessionRepository.findRecentActiveSession(employeeId);
        if (!session) {
            const workDate = this.calendarWorkDate(now);
            session = await attendanceSessionRepository.findByEmployeeAndWorkDate(
                employeeId,
                workDate
            );
        }

        if (!session || session.currentStatus !== "INSIDE_OFFICE") {
            return { updated: false, message: "Employee is not marked as inside office" };
        }

        const webhookId = `manual|${employeeId}|${now.toISOString()}|exit`;
        const result = await this.processEvent({
            employeeId,
            eventTime: now,
            direction: "EXIT",
            deviceId: "manual",
            webhookId,
            source: "MANUAL",
        });

        return { updated: true, message: "Employee marked as left", session: result.session };
    }

    /** Shift schedules must not auto-close presence. Card events own In/Out status. */
    async closeExpiredSessions() {
        return;
    }

    private async sumAbsenceMinutes(sessionId: string): Promise<number> {
        const intervals = await prisma.absenceInterval.findMany({
            where: { sessionId, durationMinutes: { not: null } },
        });
        return intervals.reduce((sum, i) => sum + (i.durationMinutes || 0), 0);
    }

    private async createNotification(
        employeeId: string,
        type: string,
        priority: string,
        message: string
    ) {
        await prisma.notification.create({
            data: {
                employeeId,
                notificationType: type,
                priority,
                message,
            },
        });
    }
}

export const attendanceService = new AttendanceService();
