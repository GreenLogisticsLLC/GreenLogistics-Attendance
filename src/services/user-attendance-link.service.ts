import { prisma } from "../config/database.js";
import { Roles } from "../auth/roles.js";
import { roleFromPosition, BADGE_POSITION_ROLES } from "../auth/position-role-map.js";
import { ensureFlexibleShiftId } from "./shift-default.service.js";
import { normalizeCardToken } from "../utils/helpers.js";

const ATTENDANCE_ROLES = new Set<string>([...BADGE_POSITION_ROLES]);

function displayName(firstName: string, lastName: string, username: string): string {
    const n = `${firstName || ""} ${lastName || ""}`.trim();
    return n || username;
}

function namesMatch(
    aFirst: string,
    aLast: string,
    bFirst: string,
    bLast: string
): boolean {
    return (
        aFirst.trim().toLowerCase() === bFirst.trim().toLowerCase() &&
        aLast.trim().toLowerCase() === bLast.trim().toLowerCase()
    );
}

function teamDepartmentLabel(lead: {
    firstName: string;
    lastName: string;
    username: string;
    email: string | null;
} | null): string {
    if (!lead) return "Unassigned Team";
    const blob = `${lead.firstName} ${lead.lastName} ${lead.username} ${lead.email || ""}`.toLowerCase();
    if (blob.includes("alen") || blob.includes("allen")) return "Team Alen Young";
    if (blob.includes("gary")) return "Team Gary Michael";
    return `Team ${displayName(lead.firstName, lead.lastName, lead.username)}`;
}

async function nextEmployeeNumber(): Promise<string> {
    const rows = await prisma.employee.findMany({
        select: { employeeNumber: true },
    });
    let max = 0;
    for (const row of rows) {
        const m = /^GL-(\d+)$/i.exec(row.employeeNumber || "");
        if (m) max = Math.max(max, Number(m[1]));
    }
    let n = max + 1;
    for (;;) {
        const candidate = `GL-${String(n).padStart(3, "0")}`;
        const taken = rows.some((r) => r.employeeNumber === candidate);
        if (!taken) return candidate;
        n += 1;
    }
}

async function nextCardNumber(prefix: string): Promise<string> {
    const existing = await prisma.employee.findMany({ select: { cardNumber: true } });
    const used = new Set(existing.map((e) => normalizeCardToken(e.cardNumber)));
    let i = 1;
    for (;;) {
        const card = normalizeCardToken(`${prefix}${String(i).padStart(3, "0")}`);
        if (!used.has(card)) return card;
        i += 1;
    }
}

async function resolveDepartment(user: {
    role: { roleName: string };
    firstName: string;
    lastName: string;
    username: string;
    email: string | null;
    teamLeadId: string | null;
}): Promise<string> {
    if (user.role.roleName === Roles.TeamLead) {
        return teamDepartmentLabel(user);
    }
    if (user.role.roleName === Roles.Manager || user.role.roleName === Roles.Accounting) {
        return user.role.roleName;
    }
    if (!user.teamLeadId) return "Unassigned Team";
    const lead = await prisma.user.findUnique({
        where: { userId: user.teamLeadId },
        select: {
            firstName: true,
            lastName: true,
            username: true,
            email: true,
        },
    });
    return teamDepartmentLabel(lead);
}

async function findLinkedPlatformUser(employeeId: string) {
    const byLink = await prisma.user.findFirst({
        where: { employeeId },
        include: { role: true },
    });
    if (byLink) return byLink;

    const emp = await prisma.employee.findUnique({ where: { employeeId } });
    if (!emp) return null;

    const users = await prisma.user.findMany({
        where: { isActive: true },
        include: { role: true },
    });
    const match = users.find((u) =>
        namesMatch(u.firstName, u.lastName, emp.firstName, emp.lastName)
    );
    if (!match) return null;

    await prisma.user.updateMany({
        where: { employeeId, NOT: { userId: match.userId } },
        data: { employeeId: null },
    });
    await prisma.user.update({
        where: { userId: match.userId },
        data: { employeeId },
    });
    return match;
}

/**
 * When badge Position is set to Broker / Team Lead / Accounting / Manager,
 * update the linked Green OS user's role so module access matches.
 */
export async function syncPlatformRoleFromEmployeePosition(input: {
    employeeId: string;
    position: string | null | undefined;
    actor: { userId: string; role: string };
    transferTeamToUserId?: string | null;
}): Promise<
    | { ok: true; roleSynced: boolean; message?: string; canonicalPosition: string | null }
    | { ok: false; status: number; message: string }
> {
    const roleName = roleFromPosition(input.position);
    const canonicalPosition = roleName || (input.position ? String(input.position).trim() : null);

    if (!roleName) {
        return { ok: true, roleSynced: false, canonicalPosition };
    }

    const user = await findLinkedPlatformUser(input.employeeId);
    if (!user) {
        return {
            ok: true,
            roleSynced: false,
            canonicalPosition,
            message:
                "Position saved on badge. No Green OS login linked to this employee — create/approve a platform user to grant module access.",
        };
    }

    if (user.role.roleName === roleName) {
        return { ok: true, roleSynced: false, canonicalPosition };
    }

    // Do not demote Owner / Administrator via badge Position.
    if (
        user.role.roleName === Roles.Owner ||
        user.role.roleName === Roles.Administrator
    ) {
        return {
            ok: false,
            status: 422,
            message: `Cannot change ${user.role.roleName} via badge Position. Use Platform users instead.`,
        };
    }

    const { usersService } = await import("./users.service.js");
    const result = await usersService.updateUserRole(input.actor, user.userId, roleName, {
        transferTeamToUserId: input.transferTeamToUserId,
    });
    if (!result.ok) {
        return { ok: false, status: result.status, message: result.message };
    }

    return {
        ok: true,
        roleSynced: true,
        canonicalPosition,
        message: result.data.message,
    };
}

/**
 * Ensure Broker / Team Lead / Manager / Accounting has an Attendance badge employee linked.
 */
export async function ensureAttendanceBadgeForUser(userId: string): Promise<{
    employeeId: string;
    employeeNumber: string;
    created: boolean;
} | null> {
    const user = await prisma.user.findUnique({
        where: { userId },
        include: {
            role: true,
            employee: true,
        },
    });
    if (!user || !user.isActive) return null;
    if (!ATTENDANCE_ROLES.has(user.role.roleName)) {
        return null;
    }

    if (user.employeeId && user.employee?.status === "ACTIVE") {
        const department = await resolveDepartment(user);
        if (user.employee.department !== department || user.employee.position !== user.role.roleName) {
            await prisma.employee.update({
                where: { employeeId: user.employeeId },
                data: { department, position: user.role.roleName },
            });
        }
        return {
            employeeId: user.employeeId,
            employeeNumber: user.employee.employeeNumber,
            created: false,
        };
    }

    const fn = user.firstName.trim().toLowerCase();
    const ln = user.lastName.trim().toLowerCase();
    const byName = await prisma.employee.findFirst({
        where: {
            status: "ACTIVE",
            firstName: { equals: user.firstName },
            lastName: { equals: user.lastName },
        },
    });
    let match = byName;
    if (!match) {
        const all = await prisma.employee.findMany({ where: { status: "ACTIVE" } });
        match =
            all.find(
                (e) =>
                    e.firstName.trim().toLowerCase() === fn &&
                    e.lastName.trim().toLowerCase() === ln
            ) || null;
    }

    const department = await resolveDepartment(user);

    if (match) {
        await prisma.employee.update({
            where: { employeeId: match.employeeId },
            data: {
                department,
                position: user.role.roleName,
                status: "ACTIVE",
            },
        });
        await prisma.user.updateMany({
            where: { employeeId: match.employeeId, NOT: { userId: user.userId } },
            data: { employeeId: null },
        });
        await prisma.user.update({
            where: { userId: user.userId },
            data: { employeeId: match.employeeId },
        });
        return {
            employeeId: match.employeeId,
            employeeNumber: match.employeeNumber,
            created: false,
        };
    }

    const shiftId = await ensureFlexibleShiftId();
    const employeeNumber = await nextEmployeeNumber();
    const cardPrefix =
        department === "Team Alen Young"
            ? "alen"
            : department === "Team Gary Michael"
              ? "gary"
              : "temp";
    const cardNumber = await nextCardNumber(cardPrefix);

    const employee = await prisma.employee.create({
        data: {
            employeeNumber,
            firstName: user.firstName,
            lastName: user.lastName,
            department,
            position: user.role.roleName,
            cardNumber,
            externalRef: employeeNumber,
            cardType: 2,
            status: "ACTIVE",
            shiftId,
        },
    });
    await prisma.user.update({
        where: { userId: user.userId },
        data: { employeeId: employee.employeeId },
    });
    return {
        employeeId: employee.employeeId,
        employeeNumber: employee.employeeNumber,
        created: true,
    };
}

export async function backfillMissingAttendanceBadges(): Promise<{
    checked: number;
    created: number;
    linked: number;
}> {
    const users = await prisma.user.findMany({
        where: {
            isActive: true,
            role: { roleName: { in: [...BADGE_POSITION_ROLES] } },
        },
        select: { userId: true },
    });

    let created = 0;
    let linked = 0;
    for (const u of users) {
        const result = await ensureAttendanceBadgeForUser(u.userId);
        if (!result) continue;
        if (result.created) created += 1;
        else linked += 1;
    }
    return { checked: users.length, created, linked };
}
