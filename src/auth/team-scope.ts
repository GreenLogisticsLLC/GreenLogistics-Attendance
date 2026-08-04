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

/** Active Team Leads for signup / Owner assignment (Gary, Alen, …). */
export async function listTeamLeadOptions(): Promise<TeamLeadOption[]> {
    const leads = await prisma.user.findMany({
        where: { isActive: true, role: { roleName: Roles.TeamLead } },
        select: {
            userId: true,
            firstName: true,
            lastName: true,
            username: true,
            email: true,
        },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    });
    return leads.map((u) => ({
        userId: u.userId,
        name: displayName(u),
        username: u.username,
        email: u.email,
    }));
}

export async function assertValidTeamLeadId(teamLeadId: string | null | undefined): Promise<string | null> {
    if (!teamLeadId) return null;
    const lead = await prisma.user.findFirst({
        where: {
            userId: teamLeadId,
            isActive: true,
            role: { roleName: Roles.TeamLead },
        },
        select: { userId: true },
    });
    return lead?.userId || null;
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
