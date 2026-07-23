import { prisma } from "../config/database.js";

/** Default shift when registration does not select Day/Night. Not used for In/Out status. */
export async function ensureFlexibleShiftId(): Promise<string> {
    const shift = await prisma.shift.upsert({
        where: { shiftName: "Flexible" },
        update: {},
        create: {
            shiftName: "Flexible",
            startTime: "00:00",
            endTime: "23:59",
            gracePeriodMinutes: 0,
            crossMidnight: false,
        },
    });
    return shift.shiftId;
}
