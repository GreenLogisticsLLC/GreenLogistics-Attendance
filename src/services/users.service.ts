import { prisma } from "../config/database.js";
import { normalizeCardToken } from "../utils/helpers.js";
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

        const user = await prisma.user.findUnique({
            where: { userId },
            include: { role: true },
        });
        if (!user) {
            return { ok: false as const, status: 404, message: "User not found" };
        }

        if (user.role.roleName === Roles.Owner && roleName !== Roles.Owner) {
            const ownerCount = await prisma.user.count({
                where: { role: { roleName: Roles.Owner }, isActive: true },
            });
            if (ownerCount <= 1) {
                return {
                    ok: false as const,
                    status: 422,
                    message: "Cannot change role of the last active Owner",
                };
            }
        }

        const role = await prisma.role.upsert({
            where: { roleName },
            update: {
                description: ROLE_DESCRIPTIONS[roleName] || undefined,
            },
            create: {
                roleName,
                description: ROLE_DESCRIPTIONS[roleName] || roleName,
            },
        });

        const updated = await prisma.user.update({
            where: { userId },
            data: { roleId: role.roleId },
            include: { role: true },
        });

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
    }

    /**
     * Permanently remove a platform user and related GreenOS data.
     * Sequential deletes (no long interactive transaction) — SQLite on Contabo
     * was timing out interactive $transaction during email-poller lock contention.
     */
    async deleteUser(actor: { userId: string; role: string }, userId: string) {
        if (!userId) {
            return { ok: false as const, status: 422, message: "userId is required" };
        }
        if (actor.userId === userId) {
            return { ok: false as const, status: 422, message: "You cannot delete your own account" };
        }

        const user = await prisma.user.findUnique({
            where: { userId },
            include: { role: true, employee: true },
        });
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
            const ownerCount = await prisma.user.count({
                where: { role: { roleName: Roles.Owner }, isActive: true },
            });
            if (ownerCount <= 1) {
                return {
                    ok: false as const,
                    status: 422,
                    message: "Cannot delete the last active Owner",
                };
            }
        }

        const deleted: Record<string, number> = {};

        try {
            const audit = await prisma.auditLog.deleteMany({ where: { userId } });
            deleted.auditLogs = audit.count;

            const shipments = await prisma.shipmentLead.findMany({
                where: { assignedBrokerId: userId },
                select: { shipmentLeadId: true },
            });
            const shipmentIds = shipments.map((s) => s.shipmentLeadId);
            if (shipmentIds.length) {
                const importLogs = await prisma.shipmentImportLog.deleteMany({
                    where: { shipmentLeadId: { in: shipmentIds } },
                });
                deleted.shipmentImportLogs = importLogs.count;
                // Remove timeline first (no FK cascade guarantee on all envs)
                await prisma.shipmentTimelineEvent.deleteMany({
                    where: { shipmentLeadId: { in: shipmentIds } },
                });
                const leads = await prisma.shipmentLead.deleteMany({
                    where: { shipmentLeadId: { in: shipmentIds } },
                });
                deleted.shipmentLeads = leads.count;
            } else {
                deleted.shipmentLeads = 0;
                deleted.shipmentImportLogs = 0;
            }

            await prisma.shipmentTimelineEvent.updateMany({
                where: { actorUserId: userId },
                data: { actorUserId: null },
            });

            const assignLogs = await prisma.assignmentLog.deleteMany({
                where: { assignedUserId: userId },
            });
            deleted.assignmentLogs = assignLogs.count;

            const queue = await prisma.assignmentQueueState.findUnique({
                where: { queueKey: "brokers" },
            });
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
                    await prisma.assignmentQueueState.update({
                        where: { queueKey: "brokers" },
                        data: {
                            orderedUserIdsJson: JSON.stringify(filtered),
                            nextIndex: Math.min(queue.nextIndex, Math.max(filtered.length - 1, 0)),
                        },
                    });
                    deleted.removedFromAssignmentQueue = 1;
                }
            }

            const pendingOr: Array<{ username: string } | { email: string }> = [
                { username: user.username },
            ];
            if (user.email) pendingOr.push({ email: user.email });
            const pending = await prisma.pendingRegistration.deleteMany({
                where: { OR: pendingOr },
            });
            deleted.pendingRegistrations = pending.count;

            const employeeId = user.employeeId;
            if (employeeId) {
                await prisma.user.update({
                    where: { userId },
                    data: { employeeId: null },
                });
            }

            await prisma.user.delete({ where: { userId } });
            deleted.users = 1;

            if (employeeId) {
                const employee = await prisma.employee.findUnique({ where: { employeeId } });
                if (employee) {
                    const sessions = await prisma.attendanceSession.findMany({
                        where: { employeeId },
                        select: { sessionId: true },
                    });
                    const sessionIds = sessions.map((s) => s.sessionId);
                    if (sessionIds.length) {
                        await prisma.absenceInterval.deleteMany({
                            where: { sessionId: { in: sessionIds } },
                        });
                    }
                    await prisma.attendanceEvent.deleteMany({ where: { employeeId } });
                    await prisma.attendanceSession.deleteMany({ where: { employeeId } });
                    await prisma.notification.deleteMany({ where: { employeeId } });
                    await prisma.pendingCardScan.deleteMany({
                        where: { cardToken: normalizeCardToken(employee.cardNumber) },
                    });
                    await prisma.assignmentLog.deleteMany({
                        where: { assignedEmployeeId: employeeId },
                    });
                    await prisma.employee.delete({ where: { employeeId } });
                    deleted.linkedEmployees = 1;
                    deleted.attendanceSessions = sessions.length;
                }
            }
        } catch (err) {
            console.error("[users] deleteUser failed:", err);
            const message = err instanceof Error ? err.message : "Delete failed";
            return {
                ok: false as const,
                status: 500,
                message: `Could not delete user (database busy or locked). Try again. ${message}`,
            };
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
    }
}

export const usersService = new UsersService();
