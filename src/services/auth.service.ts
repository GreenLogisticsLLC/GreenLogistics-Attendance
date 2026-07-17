import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../config/database.js";
import { config } from "../config/env.js";
import { sendMail } from "./email.service.js";

export const SIGNUP_ROLES = ["Owner", "Accounting", "Manager", "Broker"] as const;
export type SignupRole = (typeof SIGNUP_ROLES)[number];

const ROLE_DESCRIPTIONS: Record<SignupRole, string> = {
    Owner: "Company owner — full access to the whole system",
    Accounting: "Accounting — finance-focused access (to be refined)",
    Manager: "Manager — operations access except financial structures (to be refined)",
    Broker: "Broker — logistics coordination access (to be refined)",
};

type ApprovalTokenPayload = {
    pendingId: string;
    purpose: "registration-approval";
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

    private createApprovalToken(pendingId: string) {
        return jwt.sign(
            { pendingId, purpose: "registration-approval" } satisfies ApprovalTokenPayload,
            config.jwtSecret,
            { expiresIn: "7d" }
        );
    }

    private verifyApprovalToken(token: string): ApprovalTokenPayload | null {
        try {
            const payload = jwt.verify(token, config.jwtSecret) as ApprovalTokenPayload;
            if (payload.purpose !== "registration-approval" || !payload.pendingId) return null;
            return payload;
        } catch {
            return null;
        }
    }

    private buildApprovalEmail(pending: {
        pendingId: string;
        firstName: string;
        lastName: string;
        username: string;
        email: string;
        requestedRole: string;
    }) {
        const token = this.createApprovalToken(pending.pendingId);
        const approveUrl = `${config.publicAppUrl}/api/v1/auth/registration/approve?token=${encodeURIComponent(token)}`;
        const rejectUrl = `${config.publicAppUrl}/api/v1/auth/registration/reject?token=${encodeURIComponent(token)}`;
        const roleNote = ROLE_DESCRIPTIONS[pending.requestedRole as SignupRole] || pending.requestedRole;

        const subject = `[Green OS] New registration request — ${pending.requestedRole}`;
        const text = [
            "A person wants to register on os.greengrouplogistics.com",
            "",
            `Name: ${pending.firstName} ${pending.lastName}`,
            `Username: ${pending.username}`,
            `Email: ${pending.email}`,
            `Requested access: ${pending.requestedRole}`,
            `Role note: ${roleNote}`,
            "",
            `Approve: ${approveUrl}`,
            `Reject: ${rejectUrl}`,
            "",
            "This link is valid for 7 days.",
        ].join("\n");

        const html = `
          <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#111">
            <h2>New Green OS registration request</h2>
            <p>Someone wants to register on <strong>os.greengrouplogistics.com</strong>.</p>
            <table style="border-collapse:collapse;margin:16px 0">
              <tr><td style="padding:4px 12px 4px 0"><strong>Name</strong></td><td>${pending.firstName} ${pending.lastName}</td></tr>
              <tr><td style="padding:4px 12px 4px 0"><strong>Username</strong></td><td>${pending.username}</td></tr>
              <tr><td style="padding:4px 12px 4px 0"><strong>Email</strong></td><td>${pending.email}</td></tr>
              <tr><td style="padding:4px 12px 4px 0"><strong>Requested access</strong></td><td><strong>${pending.requestedRole}</strong></td></tr>
              <tr><td style="padding:4px 12px 4px 0"><strong>Role note</strong></td><td>${roleNote}</td></tr>
            </table>
            <p>
              <a href="${approveUrl}" style="display:inline-block;background:#10b981;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;margin-right:8px">Approve registration</a>
              <a href="${rejectUrl}" style="display:inline-block;background:#ef4444;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Reject</a>
            </p>
            <p style="color:#666;font-size:13px">Links are valid for 7 days.</p>
          </div>
        `;

        return { subject, text, html };
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
        const email = input.email?.trim().toLowerCase() || "";
        const roleName = input.role.trim();

        if (!username || !input.password || !firstName || !lastName || !email) {
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

        const existingUser = await prisma.user.findFirst({
            where: {
                OR: [{ username }, { email }],
            },
        });
        if (existingUser) {
            return { ok: false as const, status: 409, message: "Username or email already exists" };
        }

        const existingPending = await prisma.pendingRegistration.findFirst({
            where: {
                status: "PENDING",
                OR: [{ username }, { email }],
            },
        });
        if (existingPending) {
            return {
                ok: false as const,
                status: 409,
                message: "A registration request with this username or email is already pending approval",
            };
        }

        const passwordHash = await bcrypt.hash(input.password, 12);
        const pending = await prisma.pendingRegistration.create({
            data: {
                username,
                passwordHash,
                firstName,
                lastName,
                email,
                requestedRole: roleName,
                status: "PENDING",
            },
        });

        try {
            const mail = this.buildApprovalEmail(pending);
            await sendMail({
                to: config.approvalEmail,
                subject: mail.subject,
                text: mail.text,
                html: mail.html,
            });
        } catch (err) {
            await prisma.pendingRegistration.delete({ where: { pendingId: pending.pendingId } });
            const message = err instanceof Error ? err.message : "Failed to send approval email";
            return { ok: false as const, status: 503, message };
        }

        return {
            ok: true as const,
            data: {
                pending: true,
                message:
                    "Registration request submitted. An administrator will review it and approve access by email.",
            },
        };
    }

    async decideRegistration(token: string, decision: "APPROVED" | "REJECTED") {
        const payload = this.verifyApprovalToken(token);
        if (!payload) {
            return { ok: false as const, status: 400, message: "Invalid or expired approval link" };
        }

        const pending = await prisma.pendingRegistration.findUnique({
            where: { pendingId: payload.pendingId },
        });
        if (!pending) {
            return { ok: false as const, status: 404, message: "Registration request not found" };
        }
        if (pending.status !== "PENDING") {
            return {
                ok: false as const,
                status: 409,
                message: `This request was already ${pending.status.toLowerCase()}`,
            };
        }

        if (decision === "REJECTED") {
            await prisma.pendingRegistration.update({
                where: { pendingId: pending.pendingId },
                data: { status: "REJECTED", decidedAt: new Date() },
            });
            return {
                ok: true as const,
                message: `Registration for ${pending.username} was rejected.`,
            };
        }

        const conflict = await prisma.user.findFirst({
            where: {
                OR: [{ username: pending.username }, { email: pending.email }],
            },
        });
        if (conflict) {
            await prisma.pendingRegistration.update({
                where: { pendingId: pending.pendingId },
                data: { status: "REJECTED", decidedAt: new Date() },
            });
            return {
                ok: false as const,
                status: 409,
                message: "Username or email already exists — request was closed",
            };
        }

        const role = await this.ensureRole(pending.requestedRole as SignupRole);
        await prisma.user.create({
            data: {
                username: pending.username,
                passwordHash: pending.passwordHash,
                firstName: pending.firstName,
                lastName: pending.lastName,
                email: pending.email,
                roleId: role.roleId,
            },
        });

        await prisma.pendingRegistration.update({
            where: { pendingId: pending.pendingId },
            data: { status: "APPROVED", decidedAt: new Date() },
        });

        return {
            ok: true as const,
            message: `Registration approved. ${pending.firstName} ${pending.lastName} (${pending.username}) can now sign in as ${pending.requestedRole}.`,
        };
    }

    async login(username: string, password: string) {
        const identifier = username.trim();
        if (!identifier || !password) return null;

        const looksLikeEmail = identifier.includes("@");
        const user = await prisma.user.findFirst({
            where: looksLikeEmail
                ? { email: identifier.toLowerCase() }
                : { username: identifier },
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
