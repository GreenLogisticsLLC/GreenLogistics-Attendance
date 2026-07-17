import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../config/database.js";
import { config } from "../config/env.js";

export const SIGNUP_ROLES = ["Owner", "Accounting", "Manager", "Broker"] as const;
export type SignupRole = (typeof SIGNUP_ROLES)[number];

const ROLE_DESCRIPTIONS: Record<SignupRole, string> = {
    Owner: "Company owner — full access",
    Accounting: "Accounting — reports and finance view",
    Manager: "Operational management",
    Broker: "Broker — logistics coordination view",
};

export class AuthService {
    private async issueToken(user: {
        userId: string;
        username: string;
        firstName: string;
        lastName: string;
        role: { roleName: string };
    }) {
        const token = jwt.sign(
            {
                userId: user.userId,
                username: user.username,
                role: user.role.roleName,
            },
            config.jwtSecret,
            { expiresIn: "8h" }
        );

        return {
            token,
            user: {
                userId: user.userId,
                username: user.username,
                firstName: user.firstName,
                lastName: user.lastName,
                role: user.role.roleName,
            },
        };
    }

    private async ensureRole(roleName: SignupRole) {
        return prisma.role.upsert({
            where: { roleName },
            update: {},
            create: {
                roleName,
                description: ROLE_DESCRIPTIONS[roleName],
            },
        });
    }

    async register(input: {
        username: string;
        password: string;
        firstName: string;
        lastName: string;
        email?: string;
        role: string;
    }) {
        const username = input.username.trim();
        const firstName = input.firstName.trim();
        const lastName = input.lastName.trim();
        const email = input.email?.trim().toLowerCase() || null;
        const roleName = input.role.trim();

        if (!username || !input.password || !firstName || !lastName) {
            return { ok: false as const, status: 422, message: "All required fields must be filled" };
        }
        if (input.password.length < 6) {
            return { ok: false as const, status: 422, message: "Password must be at least 6 characters" };
        }
        if (!SIGNUP_ROLES.includes(roleName as SignupRole)) {
            return {
                ok: false as const,
                status: 422,
                message: `Role must be one of: ${SIGNUP_ROLES.join(", ")}`,
            };
        }

        const existing = await prisma.user.findFirst({
            where: {
                OR: [
                    { username },
                    ...(email ? [{ email }] : []),
                ],
            },
        });
        if (existing) {
            return { ok: false as const, status: 409, message: "Username or email already exists" };
        }

        const role = await this.ensureRole(roleName as SignupRole);
        const passwordHash = await bcrypt.hash(input.password, 12);
        const user = await prisma.user.create({
            data: {
                username,
                passwordHash,
                firstName,
                lastName,
                email,
                roleId: role.roleId,
            },
            include: { role: true },
        });

        const result = await this.issueToken(user);
        return { ok: true as const, data: result };
    }

    async login(username: string, password: string) {
        const identifier = username.trim();
        const user = await prisma.user.findFirst({
            where: {
                OR: [
                    { username: identifier },
                    { email: identifier.toLowerCase() },
                ],
            },
            include: { role: true },
        });

        if (!user || !user.isActive) {
            return null;
        }

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) return null;

        await prisma.user.update({
            where: { userId: user.userId },
            data: { lastLogin: new Date() },
        });

        return this.issueToken(user);
    }

    verifyToken(token: string) {
        try {
            return jwt.verify(token, config.jwtSecret) as {
                userId: string;
                username: string;
                role: string;
            };
        } catch {
            return null;
        }
    }
}

export const authService = new AuthService();
