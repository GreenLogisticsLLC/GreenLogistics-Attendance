import { prisma } from "../config/database.js";
import { Roles } from "../auth/roles.js";
import { ensureFlexibleShiftId } from "./shift-default.service.js";
import { normalizeCardToken } from "../utils/helpers.js";

const ATTENDANCE_ROLES = new Set<string>([Roles.Broker, Roles.TeamLead]);

function displayName(firstName: string, lastName: string, username: string): string {
    const n = `${firstName || ""} ${lastName || ""}`.trim();
    return n || username;
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

/**
 * Ensure Broker / Team Lead has an Attendance badge employee linked to the platform user.
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
    // SQLite is case-sensitive for equals depending on collation — also scan loosely
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
        // Clear other users pointing at this employee
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
            shiftId,
            status: "ACTIVE",
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

/** Link/create Attendance badges for all active Brokers and Team Leads missing one. */
export async function backfillMissingAttendanceBadges(): Promise<{
    checked: number;
    created: number;
    linked: number;
}> {
    const users = await prisma.user.findMany({
        where: {
            isActive: true,
            role: { roleName: { in: [Roles.Broker, Roles.TeamLead] } },
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
