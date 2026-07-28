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
    isKnownRole,
} from "../auth/roles.js";

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
                include: { role: true },
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
            }));
        });
    }

    async updateUserRole(actor: { userId: string; role: string }, userId: string, roleName: string) {
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
                    data: { roleId: role.roleId },
                    include: { role: true },
                })
            );

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
                    message: `Role updated: ${user.role.roleName} → ${updated.role.roleName}. User must sign in again for the new access to apply.`,
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
