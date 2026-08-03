import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../config/database.js";
import { config } from "../config/env.js";
import { sendMail } from "./email.service.js";
import {
    ROLE_DESCRIPTIONS,
    Roles,
    SIGNUP_ROLE_NAMES,
    type SignupRoleName,
} from "../auth/roles.js";
import { assertValidTeamLeadId, listTeamLeadOptions } from "../auth/team-scope.js";

export const SIGNUP_ROLES = SIGNUP_ROLE_NAMES;
export type SignupRole = SignupRoleName;

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

    private async ensureRole(roleName: string) {
        return prisma.role.upsert({
            where: { roleName },
            update: {
                description: ROLE_DESCRIPTIONS[roleName] || undefined,
            },
            create: {
                roleName,
                description: ROLE_DESCRIPTIONS[roleName] || roleName,
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
        requestedTeamLeadId?: string | null;
        teamLeadName?: string | null;
    }) {
        const token = this.createApprovalToken(pending.pendingId);
        const approveUrl = `${config.publicAppUrl}/api/v1/auth/registration/approve?token=${encodeURIComponent(token)}`;
        const rejectUrl = `${config.publicAppUrl}/api/v1/auth/registration/reject?token=${encodeURIComponent(token)}`;
        const roleNote = ROLE_DESCRIPTIONS[pending.requestedRole] || pending.requestedRole;
        const isBroker = pending.requestedRole === Roles.Broker;
        const teamLeadLabel = pending.teamLeadName || pending.requestedTeamLeadId || "";

        const subject = isBroker
            ? `[Green OS] Broker registration request — ${pending.firstName} ${pending.lastName}`
            : `[Green OS] New registration request — ${pending.requestedRole}`;
        const text = [
            isBroker
                ? "A person registered as a Broker and requests access to Green OS."
                : "A person wants to register on os.greengrouplogistics.com",
            "",
            `Name: ${pending.firstName} ${pending.lastName}`,
            `Username: ${pending.username}`,
            `Email: ${pending.email}`,
            `Requested access: ${pending.requestedRole}`,
            `Role note: ${roleNote}`,
            ...(teamLeadLabel ? [`Team Lead: ${teamLeadLabel}`] : []),
            "",
            isBroker
                ? "If you Approve, they join only that Team Lead's team (Gary and Alen stay isolated)."
                : "If you Approve, they will receive the requested role access.",
            "",
            `Approve: ${approveUrl}`,
            `Reject: ${rejectUrl}`,
            "",
            "This link is valid for 7 days.",
        ].join("\n");

        const html = `
          <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#111">
            <h2>${isBroker ? "Broker registration request" : "New Green OS registration request"}</h2>
            <p>${
                isBroker
                    ? "Someone registered as a <strong>Broker</strong> and is waiting for your approval."
                    : "Someone wants to register on <strong>os.greengrouplogistics.com</strong>."
            }</p>
            <table style="border-collapse:collapse;margin:16px 0">
              <tr><td style="padding:4px 12px 4px 0"><strong>Name</strong></td><td>${pending.firstName} ${pending.lastName}</td></tr>
              <tr><td style="padding:4px 12px 4px 0"><strong>Username</strong></td><td>${pending.username}</td></tr>
              <tr><td style="padding:4px 12px 4px 0"><strong>Email</strong></td><td>${pending.email}</td></tr>
              <tr><td style="padding:4px 12px 4px 0"><strong>Requested access</strong></td><td><strong>${pending.requestedRole}</strong></td></tr>
              <tr><td style="padding:4px 12px 4px 0"><strong>Role note</strong></td><td>${roleNote}</td></tr>
              ${
                  teamLeadLabel
                      ? `<tr><td style="padding:4px 12px 4px 0"><strong>Team Lead</strong></td><td><strong>${teamLeadLabel}</strong></td></tr>`
                      : ""
              }
            </table>
            <p>${
                isBroker
                    ? "Approve → Broker under that Team Lead only. Teams of Gary and Alen cannot see each other."
                    : "Approve to grant the requested role."
            }</p>
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
        teamLeadId?: string;
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

        let requestedTeamLeadId: string | null = null;
        if (roleName === Roles.Broker) {
            const leads = await listTeamLeadOptions();
            if (!leads.length) {
                return {
                    ok: false as const,
                    status: 422,
                    message:
                        "No Team Lead accounts exist yet. Ask the Owner to create Gary / Alen as Team Lead first.",
                };
            }
            requestedTeamLeadId = await assertValidTeamLeadId(input.teamLeadId);
            if (!requestedTeamLeadId) {
                return {
                    ok: false as const,
                    status: 422,
                    message: "Select a Team Lead (Gary or Alen) for this Broker account",
                };
            }
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
                requestedTeamLeadId,
                status: "PENDING",
            },
        });

        const leads = requestedTeamLeadId ? await listTeamLeadOptions() : [];
        const teamLeadName =
            leads.find((l) => l.userId === requestedTeamLeadId)?.name || null;

        try {
            const mail = this.buildApprovalEmail({ ...pending, teamLeadName });
            await sendMail({
                to: config.approvalEmail,
                subject: mail.subject,
                text: mail.text,
                html: mail.html,
            });
        } catch (err) {
            const mail = this.buildApprovalEmail({ ...pending, teamLeadName });
            console.error("[auth] Approval email failed; pending registration kept:", err);
            console.log("[auth] Manual approve URL:", mail.text.match(/Approve: (.+)/)?.[1] || "(see logs)");
            console.log("[auth] Manual reject URL:", mail.text.match(/Reject: (.+)/)?.[1] || "(see logs)");

            const detail = err instanceof Error ? err.message : "Failed to send approval email";
            return {
                ok: true as const,
                data: {
                    pending: true,
                    emailSent: false,
                    message:
                        "Registration request saved and is waiting for approval. " +
                        "The notification email to the administrator could not be sent yet — " +
                        "the owner will approve it once mail is fixed. " +
                        `(${detail})`,
                },
            };
        }

        return {
            ok: true as const,
            data: {
                pending: true,
                emailSent: true,
                message:
                    "Registration request submitted. An administrator will review it and approve access by email.",
            },
        };
    }

    async listPublicTeamLeads() {
        return listTeamLeadOptions();
    }

    /**
     * Retry approval notices after the company Gmail OAuth connection is refreshed.
     * Pending registrations remain valid if their first delivery attempt failed.
     */
    async resendPendingApprovalEmails(limit = 20, registrationEmail?: string) {
        const pending = await prisma.pendingRegistration.findMany({
            where: {
                status: "PENDING",
                ...(registrationEmail
                    ? { email: registrationEmail.trim().toLowerCase() }
                    : {}),
            },
            orderBy: { createdAt: "desc" },
            take: limit,
        });
        const results: Array<{ pendingId: string; email: string; sent: boolean; error?: string }> = [];

        for (const registration of pending) {
            try {
                await sendMail({
                    to: config.approvalEmail,
                    ...this.buildApprovalEmail(registration),
                });
                results.push({
                    pendingId: registration.pendingId,
                    email: registration.email,
                    sent: true,
                });
            } catch (err) {
                results.push({
                    pendingId: registration.pendingId,
                    email: registration.email,
                    sent: false,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        return {
            attempted: results.length,
            sent: results.filter((result) => result.sent).length,
            failed: results.filter((result) => !result.sent).length,
            results,
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
        let teamLeadId: string | null = null;
        if (pending.requestedRole === Roles.Broker) {
            teamLeadId = await assertValidTeamLeadId(pending.requestedTeamLeadId);
            if (!teamLeadId) {
                return {
                    ok: false as const,
                    status: 422,
                    message:
                        "Cannot approve: Broker has no valid Team Lead selected. Reject and ask them to re-register choosing Gary or Alen.",
                };
            }
        }

        await prisma.user.create({
            data: {
                username: pending.username,
                passwordHash: pending.passwordHash,
                firstName: pending.firstName,
                lastName: pending.lastName,
                email: pending.email,
                roleId: role.roleId,
                ...(teamLeadId ? { teamLeadId } : {}),
            },
        });

        await prisma.pendingRegistration.update({
            where: { pendingId: pending.pendingId },
            data: { status: "APPROVED", decidedAt: new Date() },
        });

        return {
            ok: true as const,
            message: `Registration approved. ${pending.firstName} ${pending.lastName} (${pending.username}) can now sign in as ${pending.requestedRole}${
                teamLeadId ? " (team-scoped to their Team Lead)" : ""
            }.`,
        };
    }

    async login(username: string, password: string) {
        const identifier = username.trim();
        if (!identifier || !password) {
            return { ok: false as const, status: 422, message: "Username or email and password are required" };
        }

        const normalizedEmail = identifier.toLowerCase();

        const user = await prisma.user.findFirst({
            where: {
                OR: [{ username: identifier }, { email: normalizedEmail }],
            },
            include: { role: true },
        });

        if (!user) {
            try {
                const pending = await prisma.pendingRegistration.findFirst({
                    where: {
                        status: "PENDING",
                        OR: [{ email: normalizedEmail }, { username: identifier }],
                    },
                });
                if (pending) {
                    return {
                        ok: false as const,
                        status: 403,
                        message:
                            "Your registration is waiting for administrator approval. Check back after you receive approval.",
                    };
                }
            } catch {
                // pending_registrations table may not exist yet
            }
            return { ok: false as const, status: 401, message: "Invalid credentials" };
        }

        if (!user.isActive) {
            return { ok: false as const, status: 403, message: "Account is disabled" };
        }

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
            return { ok: false as const, status: 401, message: "Invalid credentials" };
        }

        await prisma.user.update({
            where: { userId: user.userId },
            data: { lastLogin: new Date() },
        });

        return { ok: true as const, data: await this.issueToken(user) };
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
