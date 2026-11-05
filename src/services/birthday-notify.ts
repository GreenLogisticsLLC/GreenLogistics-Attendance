import { prisma } from "../config/database.js";
import { sseEmitToUser } from "../modules/crm/services/realtime.hub.js";
import { platformNotificationService } from "../modules/shipment/services/platform-notification.service.js";
import { birthdayNoticeKey, isBirthdayOn, yerevanDate } from "./birthday.js";

export const BIRTHDAY_NOTIFICATION = "BIRTHDAY";

/** Tell every active Owner and Manager, once per person per Yerevan year. */
export async function notifyTodayBirthdays(now = new Date()): Promise<number> {
    const today = yerevanDate(now);
    const people = await prisma.user.findMany({
        where: { isActive: true, birthDate: { not: null } },
        select: { userId: true, firstName: true, lastName: true, birthDate: true },
    });
    const celebrating = people.filter((person) => isBirthdayOn(person.birthDate, today));
    if (!celebrating.length) return 0;

    const leaders = await prisma.user.findMany({
        where: { isActive: true, role: { roleName: { in: ["Owner", "Manager"] } } },
        select: { userId: true },
    });
    if (!leaders.length) return 0;

    let sent = 0;
    for (const person of celebrating) {
        const key = birthdayNoticeKey(person.userId, today.year);
        const name = `${person.firstName || ""} ${person.lastName || ""}`.trim() || "Employee";
        for (const leader of leaders) {
            const existing = await prisma.platformNotification.findFirst({
                where: {
                    userId: leader.userId,
                    notificationType: BIRTHDAY_NOTIFICATION,
                    metaJson: { contains: key },
                },
                select: { notificationId: true },
            });
            if (existing) continue;
            const title = "CONGRATS";
            const message = `Happy Birthday, ${name}!`;
            await platformNotificationService.notifyUser({
                userId: leader.userId,
                notificationType: BIRTHDAY_NOTIFICATION,
                title,
                message,
                meta: { birthdayKey: key, personUserId: person.userId, personName: name },
            });
            sseEmitToUser(leader.userId, {
                type: BIRTHDAY_NOTIFICATION,
                title,
                message,
                personName: name,
                birthdayKey: key,
            });
            sent += 1;
        }
    }
    if (sent) console.log(`[birthday] sent ${sent} congrats notice(s)`);
    return sent;
}

let timer: NodeJS.Timeout | null = null;

export function startBirthdayScheduler() {
    if (timer) return;
    const run = () => {
        notifyTodayBirthdays().catch((err) => {
            console.warn("[birthday] check skipped:", err instanceof Error ? err.message : err);
        });
    };
    run();
    timer = setInterval(run, 30 * 60 * 1000);
}
