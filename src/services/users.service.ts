import { prisma } from "../config/database.js";
import {
    ASSIGNABLE_ROLE_NAMES,
    ROLE_DESCRIPTIONS,
    Roles,
    canAssignRole,
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
}

export const usersService = new UsersService();
