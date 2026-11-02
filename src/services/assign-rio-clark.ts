import { prisma } from "../config/database.js";
import { ensureAttendanceBadgeForUser } from "./user-attendance-link.service.js";

const MARK = "2026-11-02-rio-clark-alen";

function norm(value: string | null | undefined): string {
    return (value || "").trim().toLowerCase();
}

/**
 * Put Rio Clark (GL-016) on Alen Young's team.
 * The live board already labels his badge "Team Alen Young", but his Green OS
 * user was not linked, so Alen's dashboard omitted him. Runs once.
 */
export async function assignRioClarkToAlenYoung(): Promise<void> {
    const existing = await prisma.setting.findUnique({
        where: {
            category_settingKey: { category: "ops", settingKey: "rio_clark_team" },
        },
    });
    if (existing?.settingValue === MARK) return;

    const users = await prisma.user.findMany({ include: { role: true } });
    const alens = users.filter(
        (user) =>
            user.isActive &&
            norm(user.firstName) === "alen" &&
            norm(user.lastName) === "young"
    );
    const alen =
        alens.find((user) => user.role.roleName === "Team Lead") || alens[0];
    if (!alen) {
        console.warn("[team] Alen Young not found — Rio Clark stays unassigned");
        return;
    }

    const rios = users.filter(
        (user) =>
            user.userId !== alen.userId &&
            norm(user.firstName) === "rio" &&
            norm(user.lastName) === "clark"
    );
    const employees = await prisma.employee.findMany();
    const badges = employees.filter(
        (employee) =>
            norm(employee.employeeNumber) === "gl-016" ||
            (norm(employee.firstName) === "rio" && norm(employee.lastName) === "clark")
    );
    if (!rios.length && !badges.length) {
        console.warn("[team] Rio Clark / GL-016 not found — will retry next boot");
        return;
    }

    for (const rio of rios) {
        const badge =
            badges.find((employee) => employee.employeeId === rio.employeeId) ||
            badges.find(
                (employee) =>
                    norm(employee.firstName) === "rio" && norm(employee.lastName) === "clark"
            ) ||
            badges.find((employee) => norm(employee.employeeNumber) === "gl-016") ||
            null;
        if (badge && rio.employeeId !== badge.employeeId) {
            await prisma.user.updateMany({
                where: { employeeId: badge.employeeId, NOT: { userId: rio.userId } },
                data: { employeeId: null },
            });
        }
        await prisma.user.update({
            where: { userId: rio.userId },
            data: {
                teamLeadId: alen.userId,
                ...(badge ? { employeeId: badge.employeeId } : {}),
            },
        });
        try {
            await ensureAttendanceBadgeForUser(rio.userId);
        } catch (err) {
            console.warn("[team] Rio Clark badge sync failed:", err);
        }
    }

    if (!rios.length) {
        for (const badge of badges) {
            await prisma.employee.update({
                where: { employeeId: badge.employeeId },
                data: { department: "Team Alen Young", status: "ACTIVE" },
            });
        }
    }

    await prisma.setting.upsert({
        where: {
            category_settingKey: { category: "ops", settingKey: "rio_clark_team" },
        },
        create: {
            category: "ops",
            settingKey: "rio_clark_team",
            settingValue: MARK,
            description: "Rio Clark (GL-016) assigned to Team Lead Alen Young",
        },
        update: { settingValue: MARK },
    });
    console.log(
        `[team] Rio Clark is on Alen Young's team (${rios.length} login, ${badges.length} badge)`
    );
}
