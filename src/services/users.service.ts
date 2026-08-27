import {
    prisma,
    beginAdminWrite,
    endAdminWrite,
    withDbRetry,
} from "../config/database.js";
import { normalizeCardToken } from "../utils/helpers.js";
import {
    waitForEmailImportIdle,
} from "../modules/email/scheduler.js";
import {
    ASSIGNABLE_ROLE_NAMES,
    ROLE_DESCRIPTIONS,
    Roles,
    canAssignRole,
    canDeleteUserAccount,
    canManageUserRoles,
    isKnownRole,
} from "../auth/roles.js";
import { assertValidTeamLeadId, transferTeamLeadership } from "../auth/team-scope.js";

export class UsersService {
    listAssignableRoles(actorRole: string) {
        return ASSIGNABLE_ROLE_NAMES.filter((role) => canAssignRole(actorRole, role)).map(
            (roleName) => ({
                roleName,
                description: ROLE_DESCRIPTIONS[roleName] || roleName,
            })
        );
    }

    async listUsers() {
        return withDbRetry("listUsers", async () => {
            const users = await prisma.user.findMany({
                include: {
                    role: true,
                    teamLead: {
                        select: { userId: true, firstName: true, lastName: true, username: true },
                    },
                },
                orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
            });

            return users.map((u) => ({
                userId: u.userId,
                username: u.username,
                firstName: u.firstName,
                lastName: u.lastName,
                email: u.email,
                role: u.role.roleName,
                isActive: u.isActive,
                lastLogin: u.lastLogin,
                createdAt: u.createdAt,
                employeeId: u.employeeId,
                teamLeadId: u.teamLeadId,
                teamLeadName: u.teamLead
                    ? `${u.teamLead.firstName} ${u.teamLead.lastName}`.trim() || u.teamLead.username
                    : null,
            }));
        });
    }

    async updateBrokerTeamLead(
        actor: { userId: string; role: string },
        userId: string,
        teamLeadId: string | null
    ) {
        if (!canManageUserRoles(actor.role)) {
            return { ok: false as const, status: 403, message: "Forbidden" };
        }

        const user = await prisma.user.findUnique({
            where: { userId },
            include: { role: true },
        });
        if (!user) return { ok: false as const, status: 404, message: "User not found" };
        if (user.role.roleName !== Roles.Broker) {
            return { ok: false as const, status: 422, message: "Only Brokers can be assigned to a Team Lead" };
        }

        let nextTeamLeadId: string | null = null;
        if (teamLeadId) {
            nextTeamLeadId = await assertValidTeamLeadId(teamLeadId);
            if (!nextTeamLeadId) {
                return { ok: false as const, status: 422, message: "Invalid Team Lead" };
            }
        }

        const updated = await prisma.user.update({
            where: { userId },
            data: { teamLeadId: nextTeamLeadId },
            include: {
                role: true,
                teamLead: {
                    select: { userId: true, firstName: true, lastName: true, username: true },
                },
            },
        });

        try {
            const { ensureAttendanceBadgeForUser } = await import(
                "./user-attendance-link.service.js"
            );
            await ensureAttendanceBadgeForUser(updated.userId);
        } catch (err) {
            console.error("[users] attendance badge ensure after team-lead failed:", err);
        }

        return {
            ok: true as const,
            data: {
                userId: updated.userId,
                username: updated.username,
                role: updated.role.roleName,
                teamLeadId: updated.teamLeadId,
                teamLeadName: updated.teamLead
                    ? `${updated.teamLead.firstName} ${updated.teamLead.lastName}`.trim() ||
                      updated.teamLead.username
                    : null,
                message: nextTeamLeadId
                    ? "Broker assigned to Team Lead (promoted to Team Lead if needed)"
                    : "Broker removed from Team Lead",
            },
        };
    }

    async backfillAttendanceBadges() {
        const { backfillMissingAttendanceBadges } = await import(
            "./user-attendance-link.service.js"
        );
        return backfillMissingAttendanceBadges();
    }

    async updateUserRole(
        actor: { userId: string; role: string },
        userId: string,
        roleName: string,
        options?: {
            transferTeamToUserId?: string | null;
            takeOverFromUserId?: string | null;
        }
    ) {
        if (!roleName || !isKnownRole(roleName)) {
            return { ok: false as const, status: 422, message: "Unknown role" };
        }
        if (!canAssignRole(actor.role, roleName)) {
            return {
                ok: false as const,
                status: 403,
                message: "You do not have permission to assign this role",
            };
        }

        beginAdminWrite();
        try {
            await waitForEmailImportIdle(3_000);

            const user = await withDbRetry("findUser", () =>
                prisma.user.findUnique({
                    where: { userId },
                    include: { role: true },
                })
            );
            if (!user) {
                return { ok: false as const, status: 404, message: "User not found" };
            }

            if (user.role.roleName === Roles.Owner && roleName !== Roles.Owner) {
                const ownerCount = await withDbRetry("countOwners", () =>
                    prisma.user.count({
                        where: { role: { roleName: Roles.Owner }, isActive: true },
                    })
                );
                if (ownerCount <= 1) {
                    return {
                        ok: false as const,
                        status: 422,
                        message: "Cannot change role of the last active Owner",
                    };
                }
            }

            const wasTeamLead = user.role.roleName === Roles.TeamLead;
            const leavingTeamLead = wasTeamLead && roleName !== Roles.TeamLead;
            let transferNote = "";

            if (leavingTeamLead) {
                const brokerCount = await withDbRetry("countTeamBrokers", () =>
                    prisma.user.count({
                        where: {
                            teamLeadId: userId,
                            role: { roleName: Roles.Broker },
                        },
                    })
                );
                if (brokerCount > 0) {
                    const target = String(options?.transferTeamToUserId || "").trim();
                    if (!target) {
                        return {
                            ok: false as const,
                            status: 422,
                            message: `This Team Lead still has ${brokerCount} broker(s). Choose who takes the team (transferTeamToUserId) before changing the role.`,
                        };
                    }
                    if (target === userId) {
                        return {
                            ok: false as const,
                            status: 422,
                            message: "Cannot transfer the team to the same person",
                        };
                    }
                    const moved = await transferTeamLeadership(userId, target);
                    transferNote = ` Moved ${moved.brokersMoved} broker(s) and ${moved.notificationsMoved} notification(s) to the new Team Lead.`;
                }
            }

            const role = await withDbRetry("upsertRole", () =>
                prisma.role.upsert({
                    where: { roleName },
                    update: {
                        description: ROLE_DESCRIPTIONS[roleName] || undefined,
                    },
                    create: {
                        roleName,
                        description: ROLE_DESCRIPTIONS[roleName] || roleName,
                    },
                })
            );

            const updated = await withDbRetry("updateUserRole", () =>
                prisma.user.update({
                    where: { userId },
                    data: {
                        roleId: role.roleId,
                        // Non-brokers do not report to a Team Lead.
                        ...(roleName !== Roles.Broker ? { teamLeadId: null } : {}),
                    },
                    include: { role: true },
                })
            );

            // Optional: promote to Team Lead and take over another TL's team in one step.
            if (
                roleName === Roles.TeamLead &&
                options?.takeOverFromUserId &&
                options.takeOverFromUserId !== userId
            ) {
                const fromId = String(options.takeOverFromUserId).trim();
                const from = await prisma.user.findUnique({
                    where: { userId: fromId },
                    include: { role: true },
                });
                if (from?.role.roleName === Roles.TeamLead) {
                    const moved = await transferTeamLeadership(fromId, userId);
                    transferNote += ` Took over ${moved.brokersMoved} broker(s) and ${moved.notificationsMoved} notification(s) from previous Team Lead.`;
                }
            }

            let attendanceNote = "";
            if (
                updated.role.roleName === Roles.Broker ||
                updated.role.roleName === Roles.TeamLead
            ) {
                try {
                    const { ensureAttendanceBadgeForUser } = await import(
                        "./user-attendance-link.service.js"
                    );
                    const badge = await ensureAttendanceBadgeForUser(updated.userId);
                    if (badge?.created) {
                        attendanceNote = ` Attendance badge ${badge.employeeNumber} created.`;
                    } else if (badge) {
                        attendanceNote = ` Attendance badge ${badge.employeeNumber} linked.`;
                    }
                } catch (err) {
                    console.error("[users] attendance badge ensure failed:", err);
                }
            }

            return {
                ok: true as const,
                data: {
                    userId: updated.userId,
                    username: updated.username,
                    firstName: updated.firstName,
                    lastName: updated.lastName,
                    email: updated.email,
                    role: updated.role.roleName,
                    isActive: updated.isActive,
                    message: `Role updated: ${user.role.roleName} → ${updated.role.roleName}. User must sign in again for the new access to apply.${transferNote}${attendanceNote}`,
                },
            };
        } catch (err) {
            console.error("[users] updateUserRole failed:", err);
            const message = err instanceof Error ? err.message : "Update failed";
            return {
                ok: false as const,
                status: 500,
                message: `Could not update role (database busy). Try again. ${message}`,
            };
        } finally {
            endAdminWrite();
        }
    }

    /**
     * Permanently remove a platform user and related GreenOS data.
     * Pauses email poller + retries on SQLite lock/timeout.
     */
    async deleteUser(actor: { userId: string; role: string }, userId: string) {
        if (!userId) {
            return { ok: false as const, status: 422, message: "userId is required" };
        }
        if (actor.userId === userId) {
            return { ok: false as const, status: 422, message: "You cannot delete your own account" };
        }

        beginAdminWrite();
        try {
            await waitForEmailImportIdle(3_000);

            const user = await withDbRetry("findUserDelete", () =>
                prisma.user.findUnique({
                    where: { userId },
                    include: { role: true, employee: true },
                })
            );
            if (!user) {
                return { ok: false as const, status: 404, message: "User not found" };
            }

            if (!canDeleteUserAccount(actor.role, user.role.roleName)) {
                return {
                    ok: false as const,
                    status: 403,
                    message: "You do not have permission to delete this account",
                };
            }

            if (user.role.roleName === Roles.Owner) {
                const ownerCount = await withDbRetry("countOwnersDelete", () =>
                    prisma.user.count({
                        where: { role: { roleName: Roles.Owner }, isActive: true },
                    })
                );
                if (ownerCount <= 1) {
                    return {
                        ok: false as const,
                        status: 422,
                        message: "Cannot delete the last active Owner",
                    };
                }
            }

            const deleted: Record<string, number> = {};

            // Fast path: raw SQL batches (fewer round-trips, less lock time on SQLite)
            deleted.auditLogs = Number(
                (
                    await withDbRetry("deleteAudit", () =>
                        prisma.$executeRawUnsafe(
                            `DELETE FROM audit_logs WHERE user_id = ?`,
                            userId
                        )
                    )
                ) as number
            );

            deleted.shipmentImportLogs = Number(
                (
                    await withDbRetry("deleteImportLogs", () =>
                        prisma.$executeRawUnsafe(
                            `DELETE FROM shipment_import_logs WHERE shipment_lead_id IN (
                               SELECT shipment_lead_id FROM shipment_leads WHERE assigned_broker_id = ?
                             )`,
                            userId
                        )
                    )
                ) as number
            );

            await withDbRetry("deleteTimelineByLead", () =>
                prisma.$executeRawUnsafe(
                    `DELETE FROM shipment_timeline_events WHERE shipment_lead_id IN (
                       SELECT shipment_lead_id FROM shipment_leads WHERE assigned_broker_id = ?
                     )`,
                    userId
                )
            );

            deleted.shipmentLeads = Number(
                (
                    await withDbRetry("deleteLeads", () =>
                        prisma.$executeRawUnsafe(
                            `DELETE FROM shipment_leads WHERE assigned_broker_id = ?`,
                            userId
                        )
                    )
                ) as number
            );

            await withDbRetry("clearTimelineActor", () =>
                prisma.$executeRawUnsafe(
                    `UPDATE shipment_timeline_events SET actor_user_id = NULL WHERE actor_user_id = ?`,
                    userId
                )
            );

            deleted.assignmentLogs = Number(
                (
                    await withDbRetry("deleteAssignLogs", () =>
                        prisma.$executeRawUnsafe(
                            `DELETE FROM assignment_logs WHERE assigned_user_id = ?`,
                            userId
                        )
                    )
                ) as number
            );

            const queue = await withDbRetry("getQueue", () =>
                prisma.assignmentQueueState.findUnique({
                    where: { queueKey: "brokers" },
                })
            );
            if (queue) {
                let ordered: string[] = [];
                try {
                    ordered = JSON.parse(queue.orderedUserIdsJson || "[]");
                } catch {
                    ordered = [];
                }
                if (!Array.isArray(ordered)) ordered = [];
                const filtered = ordered.filter((id) => id !== userId);
                if (filtered.length !== ordered.length) {
                    await withDbRetry("updateQueue", () =>
                        prisma.assignmentQueueState.update({
                            where: { queueKey: "brokers" },
                            data: {
                                orderedUserIdsJson: JSON.stringify(filtered),
                                nextIndex: Math.min(
                                    queue.nextIndex,
                                    Math.max(filtered.length - 1, 0)
                                ),
                            },
                        })
                    );
                    deleted.removedFromAssignmentQueue = 1;
                }
            }

            if (user.email) {
                deleted.pendingRegistrations = Number(
                    (
                        await withDbRetry("deletePending", () =>
                            prisma.$executeRawUnsafe(
                                `DELETE FROM pending_registrations WHERE username = ? OR email = ?`,
                                user.username,
                                user.email
                            )
                        )
                    ) as number
                );
            } else {
                deleted.pendingRegistrations = Number(
                    (
                        await withDbRetry("deletePending", () =>
                            prisma.$executeRawUnsafe(
                                `DELETE FROM pending_registrations WHERE username = ?`,
                                user.username
                            )
                        )
                    ) as number
                );
            }

            const employeeId = user.employeeId;
            if (employeeId) {
                await withDbRetry("unlinkEmployee", () =>
                    prisma.$executeRawUnsafe(
                        `UPDATE users SET employee_id = NULL WHERE user_id = ?`,
                        userId
                    )
                );
            }

            await withDbRetry("deleteUserRow", () =>
                prisma.$executeRawUnsafe(`DELETE FROM users WHERE user_id = ?`, userId)
            );
            deleted.users = 1;

            if (employeeId) {
                const sessions = (await withDbRetry("findSessions", () =>
                    prisma.$queryRawUnsafe<{ session_id: string }[]>(
                        `SELECT session_id FROM attendance_sessions WHERE employee_id = ?`,
                        employeeId
                    )
                )) as { session_id: string }[];
                const sessionIds = sessions.map((s) => s.session_id);
                if (sessionIds.length) {
                    const placeholders = sessionIds.map(() => "?").join(",");
                    await withDbRetry("deleteAbsences", () =>
                        prisma.$executeRawUnsafe(
                            `DELETE FROM absence_intervals WHERE session_id IN (${placeholders})`,
                            ...sessionIds
                        )
                    );
                }
                await withDbRetry("deleteEvents", () =>
                    prisma.$executeRawUnsafe(
                        `DELETE FROM attendance_events WHERE employee_id = ?`,
                        employeeId
                    )
                );
                await withDbRetry("deleteSessions", () =>
                    prisma.$executeRawUnsafe(
                        `DELETE FROM attendance_sessions WHERE employee_id = ?`,
                        employeeId
                    )
                );
                await withDbRetry("deleteNotifications", () =>
                    prisma.$executeRawUnsafe(
                        `DELETE FROM notifications WHERE employee_id = ?`,
                        employeeId
                    )
                );
                const employee = await withDbRetry("findEmployee", () =>
                    prisma.employee.findUnique({ where: { employeeId } })
                );
                if (employee) {
                    await withDbRetry("deleteCardScans", () =>
                        prisma.pendingCardScan.deleteMany({
                            where: { cardToken: normalizeCardToken(employee.cardNumber) },
                        })
                    );
                }
                await withDbRetry("deleteAssignByEmployee", () =>
                    prisma.$executeRawUnsafe(
                        `DELETE FROM assignment_logs WHERE assigned_employee_id = ?`,
                        employeeId
                    )
                );
                await withDbRetry("deleteEmployee", () =>
                    prisma.$executeRawUnsafe(
                        `DELETE FROM employees WHERE employee_id = ?`,
                        employeeId
                    )
                );
                deleted.linkedEmployees = 1;
                deleted.attendanceSessions = sessionIds.length;
            }

            return {
                ok: true as const,
                data: {
                    userId,
                    username: user.username,
                    deleted,
                    message: `Deleted ${user.firstName} ${user.lastName} (${user.username}) and related GreenOS data.`,
                },
            };
        } catch (err) {
            console.error("[users] deleteUser failed:", err);
            const message = err instanceof Error ? err.message : "Delete failed";
            return {
                ok: false as const,
                status: 500,
                message: `Could not delete user (database busy or locked). Try again. ${message}`,
            };
        } finally {
            endAdminWrite();
        }
    }
}

export const usersService = new UsersService();
