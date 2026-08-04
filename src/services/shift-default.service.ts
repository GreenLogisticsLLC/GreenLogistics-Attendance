import { prisma } from "../config/database.js";
import {
    ATTENDANCE_DAY_END,
    ATTENDANCE_DAY_START,
    ATTENDANCE_GRACE_MINUTES,
} from "../utils/helpers.js";

const WORK_DAY_SHIFT_NAME = "Day Shift";

/** Standard office day: start 17:00, grace 15 → late after 17:15, ends 02:00. */
export async function ensureWorkDayShiftId(): Promise<string> {
    const shift = await prisma.shift.upsert({
        where: { shiftName: WORK_DAY_SHIFT_NAME },
        update: {
            startTime: ATTENDANCE_DAY_START,
            endTime: ATTENDANCE_DAY_END,
            gracePeriodMinutes: ATTENDANCE_GRACE_MINUTES,
            crossMidnight: true,
            isActive: true,
        },
        create: {
            shiftName: WORK_DAY_SHIFT_NAME,
            startTime: ATTENDANCE_DAY_START,
            endTime: ATTENDANCE_DAY_END,
            gracePeriodMinutes: ATTENDANCE_GRACE_MINUTES,
            crossMidnight: true,
            isActive: true,
        },
    });
    return shift.shiftId;
}

/** Keep Flexible aligned with the same workday rules for new badge creates. */
export async function ensureFlexibleShiftId(): Promise<string> {
    const shift = await prisma.shift.upsert({
        where: { shiftName: "Flexible" },
        update: {
            startTime: ATTENDANCE_DAY_START,
            endTime: ATTENDANCE_DAY_END,
            gracePeriodMinutes: ATTENDANCE_GRACE_MINUTES,
            crossMidnight: true,
            isActive: true,
        },
        create: {
            shiftName: "Flexible",
            startTime: ATTENDANCE_DAY_START,
            endTime: ATTENDANCE_DAY_END,
            gracePeriodMinutes: ATTENDANCE_GRACE_MINUTES,
            crossMidnight: true,
            isActive: true,
        },
    });
    return shift.shiftId;
}

/** Assign every active employee to the standard Day Shift (17:00 / grace 15). */
export async function assignAllEmployeesToWorkDayShift(): Promise<{
    shiftId: string;
    updated: number;
}> {
    const shiftId = await ensureWorkDayShiftId();
    await ensureFlexibleShiftId();
    const result = await prisma.employee.updateMany({
        where: { status: "ACTIVE" },
        data: { shiftId },
    });
    return { shiftId, updated: result.count };
}
