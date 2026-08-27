import { prisma } from "../config/database.js";
import { config } from "../config/env.js";
import {
    addDaysToDateString,
    ATTENDANCE_GRACE_MINUTES,
    diffMinutes,
    getAttendanceDayBounds,
    getAttendanceWorkDate,
} from "../utils/helpers.js";
import { employeeRepository } from "../repositories/employee.repository.js";
import { attendanceSessionRepository } from "../repositories/attendance-session.repository.js";
import { attendanceEventRepository } from "../repositories/attendance-event.repository.js";
import { assignmentEngine } from "../modules/assignment/assignment.engine.js";
import { businessRulesEngine } from "./business-rules.engine.js";
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
    private async findSessionForEvent(employeeId: string, eventTime: Date) {
        const workDate = getAttendanceWorkDate(eventTime, config.timezone);
        const bounds = getAttendanceDayBounds(workDate, config.timezone);
        let session = await attendanceSessionRepository.findByEmployeeAndWorkDate(
            employeeId,
            workDate
        );

        // Between 02:00 and 17:00 an employee still inside belongs to yesterday's
        // session until their first EXIT after 02:00 completes that workday.
        if (!session && eventTime < bounds.scheduledStart) {
            const previousWorkDate = addDaysToDateString(workDate, -1);
            const previous = await attendanceSessionRepository.findByEmployeeAndWorkDate(
                employeeId,
                previousWorkDate
            );
            if (
                previous?.currentStatus === "INSIDE_OFFICE" &&
                eventTime >= previous.scheduledEnd
            ) {
                session = previous;
            }
        }

        return { workDate, bounds, session };
    }

    async processEvent(input: ProcessEventInput) {
        const employee = await employeeRepository.findById(input.employeeId);
        if (!employee) {
            throw new Error("Employee not found");
        }

        const lookup = await this.findSessionForEvent(employee.employeeId, input.eventTime);
        const { workDate } = lookup;
        const { scheduledStart, scheduledEnd } = lookup.bounds;
        let { session } = lookup;

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
                const grace =
                    employee.shift?.gracePeriodMinutes ?? ATTENDANCE_GRACE_MINUTES;
                const lateStatus = businessRulesEngine.calculateLateStatus(
                    input.eventTime,
                    activeSession.scheduledStart,
                    grace
                );
                updates.late = lateStatus.late;
                updates.lateMinutes = lateStatus.lateMinutes;
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
            const finishesOvertime = input.eventTime >= activeSession.scheduledEnd;
            // An EXIT after 02:00 finishes overtime; earlier exits remain breaks.
            updates.currentStatus = finishesOvertime ? "COMPLETED" : "OUTSIDE_OFFICE";
            updates.lastExit = input.eventTime;
            updates.exitCount = activeSession.exitCount + 1;

            if (!finishesOvertime) {
                await prisma.absenceInterval.create({
                    data: {
                        sessionId: activeSession.sessionId,
                        exitEventId: event.eventId,
                        startTime: input.eventTime,
                    },
                });
            }
        }

        const updatedSession = await attendanceSessionRepository.update(
            activeSession.sessionId,
            updates
        );

        // Attendance is the heart of Assignment: In Office ↔ queue join, Out of Office ↔ leave.
        try {
            if (direction === "ENTRY") {
                await assignmentEngine.onBrokerEnteredOffice(employee.employeeId);
            } else {
                await assignmentEngine.onBrokerLeftOffice(employee.employeeId);
            }
        } catch (err) {
            console.error("[attendance→assignment] queue sync failed:", err);
        }

        return { event, session: updatedSession, duplicate: false, direction };
    }

    async markEmployeeLeft(employeeId: string) {
        const employee = await employeeRepository.findById(employeeId);
        if (!employee) {
            throw new Error("Employee not found");
        }

        const now = new Date();
        const { session } = await this.findSessionForEvent(employeeId, now);

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

    /** Close the 17:00–02:00 attendance day and freeze it for Reports. */
    async closeExpiredSessions() {
        const now = new Date();
        const expired = await prisma.attendanceSession.findMany({
            where: {
                scheduledEnd: { lte: now },
                currentStatus: { not: "COMPLETED" },
            },
            include: {
                absenceIntervals: {
                    where: { endTime: null },
                },
            },
            take: 200,
        });

        for (const session of expired) {
            const overtimeCutoff = new Date(
                session.scheduledEnd.getTime() + 15 * 60 * 60 * 1000
            );
            if (session.currentStatus === "INSIDE_OFFICE" && now < overtimeCutoff) {
                continue;
            }
            const wasInside = session.currentStatus === "INSIDE_OFFICE";
            const closeAt = wasInside ? overtimeCutoff : session.scheduledEnd;
            await prisma.$transaction(async (tx) => {
                for (const interval of session.absenceIntervals) {
                    await tx.absenceInterval.update({
                        where: { intervalId: interval.intervalId },
                        data: {
                            endTime: closeAt,
                            durationMinutes: diffMinutes(
                                interval.startTime,
                                closeAt
                            ),
                        },
                    });
                }
                const intervals = await tx.absenceInterval.findMany({
                    where: {
                        sessionId: session.sessionId,
                        durationMinutes: { not: null },
                    },
                });
                const totalAbsenceMinutes = intervals.reduce(
                    (sum, interval) => sum + (interval.durationMinutes || 0),
                    0
                );
                await tx.attendanceSession.update({
                    where: { sessionId: session.sessionId },
                    data: {
                        currentStatus: "COMPLETED",
                        totalAbsenceMinutes,
                        lastActivity: closeAt,
                    },
                });
            });

            // Still In Office at day rollover → open the new attendance day as INSIDE
            // so brokers keep receiving shipments without a redundant door swipe.
            if (wasInside) {
                try {
                    await this.rollInsideIntoNewWorkDay(session.employeeId, now);
                    await assignmentEngine.onBrokerEnteredOffice(session.employeeId);
                } catch (err) {
                    console.error("[attendance→assignment] day roll-forward failed:", err);
                    await assignmentEngine
                        .onBrokerLeftOffice(session.employeeId)
                        .catch(() => null);
                }
            } else {
                await assignmentEngine
                    .onBrokerLeftOffice(session.employeeId)
                    .catch((err) =>
                        console.error("[attendance→assignment] shift close failed:", err)
                    );
            }
        }

        return { checked: expired.length };
    }

    /**
     * After overtime cutoff closes yesterday's INSIDE session, open today's
     * attendance day already marked In Office (same physical presence).
     */
    private async rollInsideIntoNewWorkDay(employeeId: string, now: Date) {
        const employee = await employeeRepository.findById(employeeId);
        if (!employee?.shiftId) {
            throw new Error("Employee has no shift — cannot roll attendance day");
        }

        const workDate = getAttendanceWorkDate(now, config.timezone);
        const bounds = getAttendanceDayBounds(workDate, config.timezone);
        let session = await attendanceSessionRepository.findByEmployeeAndWorkDate(
            employeeId,
            workDate
        );

        if (!session) {
            await attendanceSessionRepository.create({
                employeeId,
                shiftId: employee.shiftId,
                workDate,
                scheduledStart: bounds.scheduledStart,
                scheduledEnd: bounds.scheduledEnd,
            });
            session = await attendanceSessionRepository.findByEmployeeAndWorkDate(
                employeeId,
                workDate
            );
        }

        if (!session) {
            throw new Error("Failed to create rolled attendance session");
        }

        if (session.currentStatus !== "INSIDE_OFFICE") {
            await attendanceSessionRepository.update(session.sessionId, {
                currentStatus: "INSIDE_OFFICE",
                lastActivity: now,
                firstEntry: session.firstEntry || now,
                updatedAt: now,
            });
        }
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
