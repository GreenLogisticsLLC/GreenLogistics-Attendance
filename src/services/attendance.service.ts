import { prisma } from "../config/database.js";
import { diffMinutes } from "../utils/helpers.js";
import { businessRulesEngine } from "./business-rules.engine.js";
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

export class AttendanceService {
    /** Each scan toggles: not inside → enter; inside → leave. Ignores reader decision field. */
    private resolveToggleDirection(currentStatus: EmployeeStatus): "ENTRY" | "EXIT" {
        if (currentStatus === "INSIDE_OFFICE") {
            return "EXIT";
        }
        return "ENTRY";
    }

    async processEvent(input: ProcessEventInput) {
        const employee = await employeeRepository.findById(input.employeeId);
        if (!employee?.shift) {
            throw new Error("Employee or shift not found");
        }

        const shift = employee.shift;
        const workDate = businessRulesEngine.determineWorkDate(input.eventTime, {
            startTime: shift.startTime,
            endTime: shift.endTime,
            gracePeriodMinutes: shift.gracePeriodMinutes,
            crossMidnight: shift.crossMidnight,
        });

        const { scheduledStart, scheduledEnd } =
            businessRulesEngine.calculateScheduledTimes(workDate, {
                startTime: shift.startTime,
                endTime: shift.endTime,
                gracePeriodMinutes: shift.gracePeriodMinutes,
                crossMidnight: shift.crossMidnight,
            });

        let session = await attendanceSessionRepository.findByEmployeeAndWorkDate(
            employee.employeeId,
            workDate
        );

        if (!session) {
            await attendanceSessionRepository.create({
                employeeId: employee.employeeId,
                shiftId: shift.shiftId,
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
        const direction = this.resolveToggleDirection(currentStatus);

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
                const lateResult = businessRulesEngine.calculateLateStatus(
                    input.eventTime,
                    scheduledStart,
                    shift.gracePeriodMinutes
                );
                updates.late = lateResult.late;
                updates.lateMinutes = lateResult.lateMinutes;

                if (lateResult.late) {
                    await this.createNotification(
                        employee.employeeId,
                        "LATE",
                        "HIGH",
                        `${employee.firstName} ${employee.lastName} arrived ${lateResult.lateMinutes} min late`
                    );
                }
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
            updates.currentStatus = "COMPLETED";
            updates.lastExit = input.eventTime;
            updates.exitCount = activeSession.exitCount + 1;

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
        }

        const updatedSession = await attendanceSessionRepository.update(
            activeSession.sessionId,
            updates
        );

        return { event, session: updatedSession, duplicate: false, direction };
    }

    async markEmployeeLeft(employeeId: string) {
        const employee = await employeeRepository.findById(employeeId);
        if (!employee?.shift) {
            throw new Error("Employee or shift not found");
        }

        const now = new Date();
        const workDate = businessRulesEngine.determineWorkDate(now, {
            startTime: employee.shift.startTime,
            endTime: employee.shift.endTime,
            gracePeriodMinutes: employee.shift.gracePeriodMinutes,
            crossMidnight: employee.shift.crossMidnight,
        });

        const session = await attendanceSessionRepository.findLatestSessionForEmployee(
            employeeId,
            workDate
        );

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

    async closeExpiredSessions() {
        const now = new Date();
        const openSessions = await prisma.attendanceSession.findMany({
            where: {
                currentStatus: { in: ["INSIDE_OFFICE", "OUTSIDE_OFFICE", "SCHEDULED"] },
                scheduledEnd: { lt: now },
            },
        });

        for (const session of openSessions) {
            const minutesPast = diffMinutes(session.scheduledEnd, now);
            if (minutesPast >= 15) {
                await attendanceSessionRepository.update(session.sessionId, {
                    currentStatus: "COMPLETED",
                });
            }
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
