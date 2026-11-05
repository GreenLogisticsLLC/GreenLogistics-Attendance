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
import {
    assertValidTeamLeadId,
    clearTeamLeadership,
    transferTeamLeadership,
} from "../auth/team-scope.js";

type DeletableUser = {
    userId: string;
    username: string;
    email: string | null;
    employeeId: string | null;
    employee: { cardNumber: string } | null;
};

async function dropUserFromAssignmentQueues(db: typeof prisma, userId: string) {
    let removed = 0;
    for (const queueKey of ["brokers", "other"]) {
        const queue = await db.assignmentQueueState.findUnique({ where: { queueKey } });
        if (!queue) continue;
        let ordered: string[] = [];
        try {
            ordered = JSON.parse(queue.orderedUserIdsJson || "[]");
        } catch {
            ordered = [];
        }
        if (!Array.isArray(ordered)) ordered = [];
        const filtered = ordered.filter((id) => id !== userId);
        if (filtered.length === ordered.length) continue;
        await db.assignmentQueueState.update({
            where: { queueKey },
            data: {
                orderedUserIdsJson: JSON.stringify(filtered),
                nextIndex: Math.min(queue.nextIndex, Math.max(filtered.length - 1, 0)),
            },
        });
        removed += 1;
    }
    return removed;
}

async function reactivateLinkedEmployee(employeeId: string | null | undefined) {
    if (!employeeId) return;
    await prisma.employee.updateMany({
        where: { employeeId },
        data: { status: "ACTIVE" },
    });
}

/** Delete every row that would block removing this login. One transaction. */
async function purgePlatformUser(actorUserId: string, user: DeletableUser) {
    const userId = user.userId;
    const leadIds = `SELECT shipment_lead_id FROM shipment_leads WHERE assigned_broker_id = ?`;
    return prisma.$transaction(
        async (tx) => {
            const deleted: Record<string, number> = {};
            const exec = async (sql: string, ...params: Array<string | null>) =>
                Number(await tx.$executeRawUnsafe(sql, ...params));

            deleted.trackingPositions = await exec(
                `DELETE FROM tracking_positions WHERE shipment_lead_id IN (${leadIds})`,
                userId
            );
            deleted.trackingEvents = await exec(
                `DELETE FROM tracking_integration_events WHERE shipment_lead_id IN (${leadIds})
                 OR tracking_id IN (
                   SELECT tracking_id FROM shipment_trackings WHERE shipment_lead_id IN (${leadIds})
                 )`,
                userId,
                userId
            );
            deleted.trackings = await exec(
                `DELETE FROM shipment_trackings WHERE shipment_lead_id IN (${leadIds})`,
                userId
            );
            for (const table of [
                "load_documents",
                "domain_events",
                "broker_response_problems",
                "load_late_problems",
                "shipment_ops_comments",
                "shipment_timeline_events",
                "shipment_import_logs",
                "broker_mailbox_messages",
                "platform_notifications",
            ]) {
                deleted[table] = await exec(
                    `DELETE FROM ${table} WHERE shipment_lead_id IN (${leadIds})`,
                    userId
                );
            }
            deleted.assignmentLogs = await exec(
                `DELETE FROM assignment_logs WHERE assigned_user_id = ? OR shipment_lead_id IN (${leadIds})`,
                userId,
                userId
            );
            deleted.shipmentLeads = await exec(
                `DELETE FROM shipment_leads WHERE assigned_broker_id = ?`,
                userId
            );
            await exec(
                `UPDATE shipment_timeline_events SET actor_user_id = NULL WHERE actor_user_id = ?`,
                userId
            );
            deleted.directCustomersReassigned = await exec(
                `UPDATE direct_customers SET created_by_user_id = ? WHERE created_by_user_id = ?`,
                actorUserId,
                userId
            );
            await exec(
                `UPDATE carriers SET assigned_broker_id = NULL WHERE assigned_broker_id = ?`,
                userId
            );
            deleted.auditLogs = await exec(`DELETE FROM audit_logs WHERE user_id = ?`, userId);
            await exec(
                `DELETE FROM document_validation_results WHERE job_id IN (
                   SELECT job_id FROM ai_document_jobs WHERE actor_user_id = ?
                 )`,
                userId
            );
            for (const [key, sql] of [
                ["aiJobs", `DELETE FROM ai_document_jobs WHERE actor_user_id = ?`],
                ["aiActions", `DELETE FROM ai_actions WHERE actor_user_id = ?`],
                ["aiRuns", `DELETE FROM ai_runs WHERE actor_user_id = ?`],
                ["aiThreads", `DELETE FROM ai_agent_threads WHERE user_id = ?`],
                ["aiFolders", `DELETE FROM ai_agent_folders WHERE user_id = ?`],
                ["mailbox", `DELETE FROM broker_mailbox_messages WHERE user_id = ?`],
                ["gmail", `DELETE FROM broker_gmail_accounts WHERE user_id = ?`],
                ["notifications", `DELETE FROM platform_notifications WHERE user_id = ?`],
            ] as const) {
                deleted[key] = await exec(sql, userId);
            }
            await exec(`UPDATE users SET team_lead_id = NULL WHERE team_lead_id = ?`, userId);
            deleted.removedFromAssignmentQueue = await dropUserFromAssignmentQueues(
                tx as unknown as typeof prisma,
                userId
            );
            if (user.email) {
                deleted.pendingRegistrations = await exec(
                    `DELETE FROM pending_registrations WHERE username = ? OR email = ?`,
                    user.username,
                    user.email
                );
            } else {
                deleted.pendingRegistrations = await exec(
                    `DELETE FROM pending_registrations WHERE username = ?`,
                    user.username
                );
            }
            if (user.employeeId) {
                await exec(`UPDATE users SET employee_id = NULL WHERE user_id = ?`, userId);
            }
            deleted.users = await exec(`DELETE FROM users WHERE user_id = ?`, userId);

            if (user.employeeId) {
                const employeeId = user.employeeId;
                await exec(
                    `DELETE FROM absence_intervals WHERE session_id IN (
                       SELECT session_id FROM attendance_sessions WHERE employee_id = ?
                     )`,
                    employeeId
                );
                await exec(`DELETE FROM attendance_events WHERE employee_id = ?`, employeeId);
                deleted.attendanceSessions = await exec(
                    `DELETE FROM attendance_sessions WHERE employee_id = ?`,
                    employeeId
                );
                await exec(`DELETE FROM notifications WHERE employee_id = ?`, employeeId);
                await exec(
                    `DELETE FROM assignment_logs WHERE assigned_employee_id = ?`,
                    employeeId
                );
                if (user.employee?.cardNumber) {
                    await tx.pendingCardScan.deleteMany({
                        where: { cardToken: normalizeCardToken(user.employee.cardNumber) },
                    });
                }
                deleted.linkedEmployees = await exec(
                    `DELETE FROM employees WHERE employee_id = ?`,
                    employeeId
                );
            }
            return deleted;
        },
        { timeout: 60_000 }
    );
}

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
                phone: u.phone,
                birthDate: u.birthDate,
                role: u.role.roleName,
                accountingSubRole: u.accountingSubRole || null,
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
            data: {
                teamLeadId: nextTeamLeadId,
                isActive: true,
                availableForAssignment: true,
            },
            include: {
                role: true,
                teamLead: {
                    select: { userId: true, firstName: true, lastName: true, username: true },
                },
            },
        });
        await reactivateLinkedEmployee(updated.employeeId);

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
            accountingSubRole?: string | null;
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
                    if (target) {
                        if (target === userId) {
                            return {
                                ok: false as const,
                                status: 422,
                                message: "Cannot transfer the team to the same person",
                            };
                        }
                        const moved = await transferTeamLeadership(userId, target);
                        transferNote = ` Moved ${moved.brokersMoved} broker(s) and ${moved.notificationsMoved} notification(s) to the new Team Lead.`;
                    } else {
                        // Owner may leave the Team Lead seat vacant — brokers stay
                        // unassigned until a new TL is appointed later.
                        const cleared = await clearTeamLeadership(userId);
                        transferNote = ` Left Team Lead vacant — unassigned ${cleared.brokersUnassigned} broker(s). Assign a new Team Lead when ready.`;
                    }
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

            const {
                AccountingSubRoles,
                isAccountingTeam,
                normalizeAccountingSubRole,
            } = await import("../auth/accounting.js");
            const accountingSubRole = isAccountingTeam(roleName)
                ? normalizeAccountingSubRole(
                      options?.accountingSubRole,
                      AccountingSubRoles.Documents
                  )
                : null;

            const prevAccountingSubRole = user.accountingSubRole || null;
            const updated = await withDbRetry("updateUserRole", () =>
                prisma.user.update({
                    where: { userId },
                    data: {
                        roleId: role.roleId,
                        accountingSubRole,
                        isActive: true,
                        availableForAssignment: true,
                        // Non-brokers do not report to a Team Lead.
                        ...(roleName !== Roles.Broker ? { teamLeadId: null } : {}),
                    },
                    include: { role: true },
                })
            );
            await reactivateLinkedEmployee(updated.employeeId);

            try {
                const roleChanged = user.role.roleName !== updated.role.roleName;
                const subChanged = String(prevAccountingSubRole || "") !== String(accountingSubRole || "");
                if (
                    roleChanged ||
                    subChanged ||
                    updated.role.roleName === Roles.Accounting ||
                    user.role.roleName === Roles.Accounting
                ) {
                    await prisma.auditLog.create({
                        data: {
                            userId: actor.userId,
                            module: "ACCOUNTING",
                            action:
                                updated.role.roleName === Roles.Accounting &&
                                user.role.roleName !== Roles.Accounting
                                    ? "EMPLOYEE_ASSIGNED_ACCOUNTING"
                                    : user.role.roleName === Roles.Accounting &&
                                        updated.role.roleName !== Roles.Accounting
                                      ? "EMPLOYEE_REMOVED_ACCOUNTING"
                                      : "ACCOUNTING_ROLE_CHANGED",
                            entityName: "User",
                            entityId: updated.userId,
                            oldValue: JSON.stringify({
                                role: user.role.roleName,
                                accountingSubRole: prevAccountingSubRole,
                            }),
                            newValue: JSON.stringify({
                                role: updated.role.roleName,
                                accountingSubRole,
                            }),
                            ipAddress: null,
                            userAgent: null,
                        },
                    });
                }
            } catch (auditErr) {
                console.warn("[users] accounting role audit failed:", auditErr);
            }

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
                updated.role.roleName === Roles.TeamLead ||
                updated.role.roleName === Roles.Manager ||
                updated.role.roleName === Roles.Accounting
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
                    accountingSubRole: updated.accountingSubRole || null,
                    isActive: updated.isActive,
                    message: `Role updated: ${user.role.roleName} → ${updated.role.roleName}${
                        accountingSubRole ? ` (${accountingSubRole})` : ""
                    }. User must sign in again for the new access to apply.${transferNote}${attendanceNote}`,
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
     * Take the person off the team and the assignment rotation.
     * The account stays so the role and Team Lead can still be changed and saved.
     */
    async removeUser(actor: { userId: string; role: string }, userId: string) {
        if (!userId) {
            return { ok: false as const, status: 422, message: "userId is required" };
        }
        if (actor.userId === userId) {
            return { ok: false as const, status: 422, message: "You cannot remove your own account" };
        }

        beginAdminWrite();
        try {
            const user = await withDbRetry("findUserRemove", () =>
                prisma.user.findUnique({
                    where: { userId },
                    include: { role: true },
                })
            );
            if (!user) {
                return { ok: false as const, status: 404, message: "User not found" };
            }
            if (!canDeleteUserAccount(actor.role, user.role.roleName)) {
                return {
                    ok: false as const,
                    status: 403,
                    message: "You do not have permission to remove this account",
                };
            }
            if (user.role.roleName === Roles.Owner) {
                const ownerCount = await prisma.user.count({
                    where: { role: { roleName: Roles.Owner }, isActive: true },
                });
                if (ownerCount <= 1 && user.isActive) {
                    return {
                        ok: false as const,
                        status: 422,
                        message: "Cannot remove the last active Owner",
                    };
                }
            }

            let brokersUnassigned = 0;
            if (user.role.roleName === Roles.TeamLead) {
                const cleared = await clearTeamLeadership(userId);
                brokersUnassigned = cleared.brokersUnassigned;
            }

            await withDbRetry("removeUserRow", () =>
                prisma.user.update({
                    where: { userId },
                    data: {
                        isActive: false,
                        availableForAssignment: false,
                        teamLeadId: null,
                    },
                })
            );
            if (user.employeeId) {
                await prisma.employee.updateMany({
                    where: { employeeId: user.employeeId },
                    data: { status: "INACTIVE" },
                });
            }
            await dropUserFromAssignmentQueues(prisma, userId);

            const name = `${user.firstName} ${user.lastName}`.trim();
            return {
                ok: true as const,
                data: {
                    userId,
                    isActive: false,
                    message:
                        `Removed ${name}. The account stays inactive so you can change the role or Team Lead and press Save.` +
                        (brokersUnassigned
                            ? ` Unassigned ${brokersUnassigned} broker(s) from this Team Lead.`
                            : ""),
                },
            };
        } catch (err) {
            console.error("[users] removeUser failed:", err);
            const message = err instanceof Error ? err.message : "Remove failed";
            return { ok: false as const, status: 500, message };
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

            const deleted = await withDbRetry("deleteUserTx", () =>
                purgePlatformUser(actor.userId, user)
            );

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

    async updateUserProfile(
        actor: { userId: string; role: string },
        userId: string,
        input: {
            firstName?: unknown;
            lastName?: unknown;
            phone?: unknown;
            email?: unknown;
            birthDate?: unknown;
            role?: unknown;
            teamLeadId?: unknown;
            transferTeamToUserId?: unknown;
            takeOverFromUserId?: unknown;
            accountingSubRole?: unknown;
        }
    ) {
        if (!canManageUserRoles(actor.role)) {
            return { ok: false as const, status: 403, message: "Forbidden" };
        }
        const firstName = String(input.firstName ?? "").trim();
        const lastName = String(input.lastName ?? "").trim();
        if (!firstName || !lastName) {
            return { ok: false as const, status: 422, message: "Name and last name are required" };
        }
        if (firstName.length > 80 || lastName.length > 80) {
            return { ok: false as const, status: 422, message: "Name is too long" };
        }
        const phoneRaw = String(input.phone ?? "").trim();
        if (phoneRaw.length > 40) {
            return { ok: false as const, status: 422, message: "Phone number is too long" };
        }
        const emailRaw = String(input.email ?? "").trim().toLowerCase();
        if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
            return { ok: false as const, status: 422, message: "Gmail address looks wrong" };
        }
        const { parseBirthDate } = await import("./birthday.js");
        const birth = parseBirthDate(input.birthDate);
        if (!birth.ok) return { ok: false as const, status: 422, message: birth.message };

        const user = await prisma.user.findUnique({
            where: { userId },
            include: { role: true },
        });
        if (!user) return { ok: false as const, status: 404, message: "User not found" };

        if (emailRaw) {
            const taken = await prisma.user.findFirst({
                where: { email: emailRaw, userId: { not: userId } },
                select: { userId: true },
            });
            if (taken) {
                return { ok: false as const, status: 422, message: "That Gmail address is already used" };
            }
        }

        const nextRole = String(input.role ?? user.role.roleName).trim() || user.role.roleName;
        const teamLeadId =
            input.teamLeadId === undefined || input.teamLeadId === null || input.teamLeadId === ""
                ? null
                : String(input.teamLeadId);
        const transferTeamToUserId =
            input.transferTeamToUserId === undefined ||
            input.transferTeamToUserId === null ||
            input.transferTeamToUserId === ""
                ? null
                : String(input.transferTeamToUserId);
        if (nextRole === Roles.Broker && !teamLeadId && !user.teamLeadId && user.role.roleName !== Roles.Broker) {
            return { ok: false as const, status: 422, message: "Select a Team Lead for this Broker" };
        }
        if (nextRole === Roles.Broker && user.role.roleName === Roles.Broker && input.teamLeadId !== undefined && !teamLeadId) {
            return { ok: false as const, status: 422, message: "Select a Team Lead for this Broker" };
        }
        if (user.role.roleName === Roles.TeamLead && nextRole !== Roles.TeamLead && !transferTeamToUserId) {
            return {
                ok: false as const,
                status: 422,
                message: "Choose who takes this Team Lead's brokers before changing the status",
            };
        }

        try {
            await prisma.user.update({
                where: { userId },
                data: {
                    firstName,
                    lastName,
                    phone: phoneRaw || null,
                    email: emailRaw || null,
                    birthDate: birth.value,
                },
            });
            if (user.employeeId) {
                await prisma.employee.update({
                    where: { employeeId: user.employeeId },
                    data: { firstName, lastName },
                });
            }
        } catch (err) {
            console.error("[users] updateUserProfile failed:", err);
            return { ok: false as const, status: 500, message: "Could not save employee details" };
        }

        let message = "Saved";
        if (nextRole !== user.role.roleName) {
            const roleResult = await this.updateUserRole(actor, userId, nextRole, {
                transferTeamToUserId,
                takeOverFromUserId:
                    input.takeOverFromUserId === undefined ||
                    input.takeOverFromUserId === null ||
                    input.takeOverFromUserId === ""
                        ? null
                        : String(input.takeOverFromUserId),
                accountingSubRole:
                    nextRole === Roles.Accounting
                        ? String(input.accountingSubRole || "DOCUMENTS")
                        : null,
            });
            if (!roleResult.ok) return roleResult;
            message = roleResult.data.message || "Saved";
        }

        if (nextRole === Roles.Broker) {
            const tlResult = await this.updateBrokerTeamLead(actor, userId, teamLeadId);
            if (!tlResult.ok) return tlResult;
        }

        try {
            const { notifyTodayBirthdays } = await import("./birthday-notify.js");
            await notifyTodayBirthdays();
        } catch (err) {
            console.warn("[birthday] notify after profile save skipped:", err);
        }

        return {
            ok: true as const,
            data: { userId, firstName, lastName, message },
        };
    }
}

export const usersService = new UsersService();
