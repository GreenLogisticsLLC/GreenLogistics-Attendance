import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../config/database.js";
import { config } from "../config/env.js";

export class AuthService {
    async login(username: string, password: string) {
        const user = await prisma.user.findUnique({
            where: { username },
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
