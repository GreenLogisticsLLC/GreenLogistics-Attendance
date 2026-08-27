import { prisma } from "../config/database.js";
import { Roles } from "./roles.js";

export type TeamLeadOption = {
    userId: string;
    name: string;
    username: string;
    email: string | null;
};

function displayName(u: {
    firstName: string;
    lastName: string;
    username: string;
}): string {
    const n = `${u.firstName || ""} ${u.lastName || ""}`.trim();
    return n || u.username;
}

/** Active people who can own a team (any may be promoted to Team Lead on assign). */
export async function listTeamLeadOptions(): Promise<TeamLeadOption[]> {
    const leads = await prisma.user.findMany({
        where: {
            isActive: true,
            role: {
                roleName: {
                    in: [
                        Roles.TeamLead,
                        Roles.Broker,
                        Roles.Manager,
                        Roles.Owner,
                        Roles.Administrator,
                    ],
                },
            },
        },
        select: {
            userId: true,
            firstName: true,
            lastName: true,
            username: true,
            email: true,
            role: { select: { roleName: true } },
        },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    });
    // Prefer existing Team Leads first in the list, then everyone else.
    leads.sort((a, b) => {
        const aTl = a.role.roleName === Roles.TeamLead ? 0 : 1;
        const bTl = b.role.roleName === Roles.TeamLead ? 0 : 1;
        if (aTl !== bTl) return aTl - bTl;
        return displayName(a).localeCompare(displayName(b));
    });
    return leads.map((u) => ({
        userId: u.userId,
        name:
            displayName(u) +
            (u.role.roleName === Roles.TeamLead ? "" : ` (${u.role.roleName})`),
        username: u.username,
        email: u.email,
    }));
}

/**
 * Ensure userId is an active Team Lead — promotes role if needed.
 * Returns userId or null if not found / inactive.
 */
export async function ensureTeamLeadRole(userId: string): Promise<string | null> {
    if (!userId) return null;
    const user = await prisma.user.findFirst({
        where: { userId, isActive: true },
        include: { role: true },
    });
    if (!user) return null;
    if (user.role.roleName === Roles.TeamLead) return user.userId;

    const role = await prisma.role.upsert({
        where: { roleName: Roles.TeamLead },
        update: {},
        create: {
            roleName: Roles.TeamLead,
            description: "Team lead — team shipments and broker oversight",
        },
    });
    await prisma.user.update({
        where: { userId },
        data: { roleId: role.roleId, teamLeadId: null },
    });
    try {
        const { ensureAttendanceBadgeForUser } = await import(
            "../services/user-attendance-link.service.js"
        );
        await ensureAttendanceBadgeForUser(userId);
    } catch (err) {
        console.error("[team-scope] badge ensure after TL promote failed:", err);
    }
    return userId;
}

export async function assertValidTeamLeadId(teamLeadId: string | null | undefined): Promise<string | null> {
    if (!teamLeadId) return null;
    // Auto-promote Brokers/Managers/etc. so Owner can assign any employee as TL.
    return ensureTeamLeadRole(teamLeadId);
}

/**
 * Move every broker (and team notifications) from one Team Lead to another.
 */
export async function transferTeamLeadership(
    fromTeamLeadId: string,
    toTeamLeadId: string
): Promise<{ brokersMoved: number; notificationsMoved: number; toTeamLeadId: string }> {
    if (!fromTeamLeadId || !toTeamLeadId) {
        throw new Error("fromTeamLeadId and toTeamLeadId are required");
    }
    if (fromTeamLeadId === toTeamLeadId) {
        return { brokersMoved: 0, notificationsMoved: 0, toTeamLeadId };
    }

    const ensured = await ensureTeamLeadRole(toTeamLeadId);
    if (!ensured) throw new Error("Target Team Lead not found or inactive");

    const brokers = await prisma.user.updateMany({
        where: {
            teamLeadId: fromTeamLeadId,
            role: { roleName: Roles.Broker },
        },
        data: { teamLeadId: toTeamLeadId },
    });

    let notificationsMoved = 0;
    try {
        const n = await prisma.platformNotification.updateMany({
            where: { userId: fromTeamLeadId },
            data: { userId: toTeamLeadId },
        });
        notificationsMoved = n.count;
    } catch (err) {
        console.warn("[team-scope] notification transfer skipped:", err);
    }

    return {
        brokersMoved: brokers.count,
        notificationsMoved,
        toTeamLeadId: ensured,
    };
}

/** Broker userIds that report to this Team Lead — hard team boundary. */
export async function listTeamBrokerIds(teamLeadUserId: string): Promise<string[]> {
    if (!teamLeadUserId) return [];
    const rows = await prisma.user.findMany({
        where: {
            teamLeadId: teamLeadUserId,
            isActive: true,
            role: { roleName: Roles.Broker },
        },
        select: { userId: true },
    });
    return rows.map((r) => r.userId);
}

export async function isBrokerOnTeam(teamLeadUserId: string, brokerUserId: string): Promise<boolean> {
    if (!teamLeadUserId || !brokerUserId) return false;
    const row = await prisma.user.findFirst({
        where: {
            userId: brokerUserId,
            teamLeadId: teamLeadUserId,
            role: { roleName: Roles.Broker },
        },
        select: { userId: true },
    });
    return Boolean(row);
}

/** Team Lead userId for a broker (for notifications). */
export async function getBrokerTeamLeadId(brokerUserId: string): Promise<string | null> {
    if (!brokerUserId) return null;
    const row = await prisma.user.findUnique({
        where: { userId: brokerUserId },
        select: { teamLeadId: true },
    });
    return row?.teamLeadId || null;
}

/** Active Attendance employeeIds for a Team Lead's team (brokers + the TL themselves). */
export async function listTeamEmployeeIds(teamLeadUserId: string): Promise<string[]> {
    if (!teamLeadUserId) return [];
    const users = await prisma.user.findMany({
        where: {
            isActive: true,
            OR: [{ userId: teamLeadUserId }, { teamLeadId: teamLeadUserId }],
            employeeId: { not: null },
        },
        select: { employeeId: true },
    });
    return users
        .map((u) => u.employeeId)
        .filter((id): id is string => Boolean(id));
}
