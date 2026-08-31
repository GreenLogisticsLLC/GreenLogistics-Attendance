import { google } from "googleapis";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { config } from "../../../config/env.js";
import { prisma } from "../../../config/database.js";
import { getGmailRedirectUri } from "./gmail-oauth.service.js";

const BROKER_GMAIL_SCOPES = [
    // Same Gmail scopes as company inbox — already approved on the Google Cloud OAuth client.
    // gmail.modify includes read (needed for uShip sync). Avoid gmail.readonly-only, which
    // often fails with "insufficient authentication scopes" when not listed on the consent screen.
    "https://www.googleapis.com/auth/gmail.modify",
];
const TOKEN_PREFIX = "enc:v1:";

type BrokerOAuthState = {
    purpose: "broker-gmail";
    userId: string;
    brokerId: string;
};

type BrokerGmailInvite = {
    purpose: "broker-gmail-invite";
    userId: string;
    brokerId: string;
};

function tokenKey(): Buffer {
    return crypto.createHash("sha256").update(config.jwtSecret).digest();
}

export function encryptBrokerRefreshToken(refreshToken: string): string {
    if (!refreshToken || refreshToken.startsWith(TOKEN_PREFIX)) return refreshToken;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", tokenKey(), iv);
    const encrypted = Buffer.concat([cipher.update(refreshToken, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${TOKEN_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString("base64url")}`;
}

export function decryptBrokerRefreshToken(value: string): string {
    if (!value || !value.startsWith(TOKEN_PREFIX)) return value;
    const packed = Buffer.from(value.slice(TOKEN_PREFIX.length), "base64url");
    if (packed.length < 29) throw new Error("Stored Gmail credential is invalid");
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const encrypted = packed.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", tokenKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function encodeBrokerOAuthState(userId: string, brokerId: string): string {
    return jwt.sign(
        { purpose: "broker-gmail", userId, brokerId } satisfies BrokerOAuthState,
        config.jwtSecret,
        { expiresIn: "10m" }
    );
}

export function parseBrokerOAuthState(state: string | undefined | null): BrokerOAuthState | null {
    if (!state) return null;
    try {
        const payload = jwt.verify(state, config.jwtSecret) as BrokerOAuthState;
        if (
            payload.purpose !== "broker-gmail" ||
            typeof payload.userId !== "string" ||
            typeof payload.brokerId !== "string"
        ) {
            return null;
        }
        return payload;
    } catch {
        return null;
    }
}

/** Owner/Admin invite: broker opens link and consents with their personal Gmail (no GreenOS login required). */
export function encodeBrokerGmailInvite(userId: string, brokerId: string): string {
    return jwt.sign(
        { purpose: "broker-gmail-invite", userId, brokerId } satisfies BrokerGmailInvite,
        config.jwtSecret,
        { expiresIn: "48h" }
    );
}

export function parseBrokerGmailInvite(token: string | undefined | null): BrokerGmailInvite | null {
    if (!token) return null;
    try {
        const payload = jwt.verify(token, config.jwtSecret) as BrokerGmailInvite;
        if (
            payload.purpose !== "broker-gmail-invite" ||
            typeof payload.userId !== "string" ||
            typeof payload.brokerId !== "string"
        ) {
            return null;
        }
        return payload;
    } catch {
        return null;
    }
}

export function isBrokerGmailConnected(account: {
    status?: string | null;
    isActive?: boolean | null;
    refreshToken?: string | null;
} | null | undefined): boolean {
    return Boolean(
        account &&
            account.status === "CONNECTED" &&
            account.isActive &&
            typeof account.refreshToken === "string" &&
            account.refreshToken.length > 0
    );
}

function createOAuthClient() {
    return new google.auth.OAuth2(
        config.gmail.clientId,
        config.gmail.clientSecret,
        getGmailRedirectUri()
    );
}

type CachedBrokerAuth = {
    brokerGmailId: string;
    refreshTokenPlain: string;
    oauth2: ReturnType<typeof createOAuthClient>;
};

export class BrokerGmailOAuthService {
    /** Reuse access tokens per mailbox; persist Google refresh-token rotations. */
    private authByAccount = new Map<string, CachedBrokerAuth>();

    isClientConfigured(): boolean {
        return Boolean(config.gmail.clientId && config.gmail.clientSecret);
    }

    invalidateBrokerClient(brokerGmailId: string) {
        this.authByAccount.delete(brokerGmailId);
    }

    invalidateAllBrokerClients() {
        this.authByAccount.clear();
    }

    /**
     * Shared OAuth2 client for one broker mailbox.
     * Listens for Google token rotation and writes the new refresh_token to DB —
     * without this, a rotated token causes permanent invalid_grant until reconnect.
     */
    getSharedAuthedClient(account: {
        brokerGmailId: string;
        refreshToken: string;
    }): ReturnType<typeof createOAuthClient> {
        const plain = decryptBrokerRefreshToken(account.refreshToken);
        const cached = this.authByAccount.get(account.brokerGmailId);
        if (cached && cached.refreshTokenPlain === plain) {
            return cached.oauth2;
        }

        this.invalidateBrokerClient(account.brokerGmailId);
        const oauth2 = createOAuthClient();
        oauth2.setCredentials({ refresh_token: plain });
        oauth2.on("tokens", (tokens) => {
            void this.persistRotatedBrokerTokens(account.brokerGmailId, tokens).catch((err) => {
                console.warn(
                    "[BROKER GMAIL] Failed to persist rotated tokens:",
                    err instanceof Error ? err.message : err
                );
            });
        });
        this.authByAccount.set(account.brokerGmailId, {
            brokerGmailId: account.brokerGmailId,
            refreshTokenPlain: plain,
            oauth2,
        });
        return oauth2;
    }

    private async persistRotatedBrokerTokens(
        brokerGmailId: string,
        tokens: { refresh_token?: string | null; access_token?: string | null }
    ) {
        if (!tokens.refresh_token) return;
        const encrypted = encryptBrokerRefreshToken(tokens.refresh_token);
        await prisma.brokerGmailAccount.update({
            where: { brokerGmailId },
            data: {
                refreshToken: encrypted,
                status: "CONNECTED",
                isActive: true,
                lastError: null,
            },
        });
        const cached = this.authByAccount.get(brokerGmailId);
        if (cached) {
            cached.refreshTokenPlain = tokens.refresh_token;
            cached.oauth2.setCredentials({
                ...cached.oauth2.credentials,
                refresh_token: tokens.refresh_token,
                access_token: tokens.access_token || cached.oauth2.credentials.access_token,
            });
        }
        console.log(
            `[BROKER GMAIL] Persisted rotated refresh token for ${brokerGmailId.slice(0, 8)}…`
        );
    }

    /** Send email as the broker's connected Gmail (From = broker). */
    async sendMailAsBroker(
        userId: string,
        options: { to: string; subject: string; text: string; html: string }
    ): Promise<{ from: string }> {
        if (!this.isClientConfigured()) {
            throw Object.assign(
                new Error("Gmail OAuth client is not configured"),
                { status: 503 }
            );
        }
        const account = await prisma.brokerGmailAccount.findUnique({ where: { userId } });
        if (!isBrokerGmailConnected(account)) {
            throw Object.assign(
                new Error(
                    "Broker Gmail is not connected. Connect your Gmail in My Workspace, then resend the carrier link."
                ),
                { status: 400, code: "BROKER_GMAIL_REQUIRED" }
            );
        }
        const oauth2 = this.getSharedAuthedClient({
            brokerGmailId: account!.brokerGmailId,
            refreshToken: account!.refreshToken,
        });
        const gmail = google.gmail({ version: "v1", auth: oauth2 });
        const from = account!.gmailAddress;
        const boundary = `greenos_${Date.now()}`;
        const encodeSubject = (subject: string) => {
            if (/^[\x20-\x7E]*$/.test(subject)) return subject;
            return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
        };
        const raw = [
            `From: ${from}`,
            `To: ${options.to}`,
            `Subject: ${encodeSubject(options.subject)}`,
            "MIME-Version: 1.0",
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
            "",
            `--${boundary}`,
            'Content-Type: text/plain; charset="UTF-8"',
            "Content-Transfer-Encoding: 7bit",
            "",
            options.text,
            `--${boundary}`,
            'Content-Type: text/html; charset="UTF-8"',
            "Content-Transfer-Encoding: 7bit",
            "",
            options.html,
            `--${boundary}--`,
            "",
        ].join("\r\n");
        const encoded = Buffer.from(raw)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
        try {
            await gmail.users.messages.send({
                userId: "me",
                requestBody: { raw: encoded },
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/insufficient|scope|403/i.test(msg)) {
                throw Object.assign(
                    new Error(
                        "Broker Gmail cannot send yet. Disconnect and reconnect Gmail so send permission is granted."
                    ),
                    { status: 403 }
                );
            }
            throw err;
        }
        return { from };
    }

    getAuthUrlForBroker(userId: string, brokerId: string): string {
        if (!this.isClientConfigured()) {
            throw new Error("Gmail OAuth client is not configured");
        }
        const oauth2 = createOAuthClient();
        return oauth2.generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            scope: BROKER_GMAIL_SCOPES,
            include_granted_scopes: false,
            state: encodeBrokerOAuthState(userId, brokerId),
        });
    }

    async exchangeCodeAndSaveForBroker(userId: string, brokerId: string, code: string) {
        if (!this.isClientConfigured()) {
            throw new Error("Gmail OAuth client is not configured");
        }
        if (!code) throw new Error("Missing authorization code");

        const user = await prisma.user.findUnique({
            where: { userId },
            include: { role: true, employee: true },
        });
        if (!user || !user.isActive || user.employeeId !== brokerId || !user.employee) {
            throw Object.assign(new Error("Broker employee account not found or inactive"), {
                status: 404,
            });
        }
        if (user.role.roleName !== "Broker") {
            throw Object.assign(new Error("Gmail can only be connected to a Broker account"), {
                status: 403,
            });
        }

        const oauth2 = createOAuthClient();
        const { tokens } = await oauth2.getToken(code);
        const existing = await prisma.brokerGmailAccount.findFirst({
            where: { OR: [{ brokerId }, { userId }] },
        });
        // Prefer brand-new refresh_token from Google. Only fall back to the
        // previously stored one when Google omits it (re-consent without rotation).
        let refreshToken = "";
        if (tokens.refresh_token) {
            refreshToken = tokens.refresh_token;
        } else if (existing?.refreshToken) {
            try {
                refreshToken = decryptBrokerRefreshToken(existing.refreshToken);
            } catch {
                refreshToken = "";
            }
        }
        if (!refreshToken) {
            throw new Error(
                "Google did not return a refresh_token. Revoke prior access in Google Account and reconnect with consent."
            );
        }

        // Drop any cached client that still holds a revoked token before this reconnect.
        if (existing?.brokerGmailId) {
            this.invalidateBrokerClient(existing.brokerGmailId);
        }

        oauth2.setCredentials(tokens);
        const gmail = google.gmail({ version: "v1", auth: oauth2 });
        const profile = await gmail.users.getProfile({ userId: "me" });
        const email = profile.data.emailAddress || "";
        if (!email) throw new Error("Could not read Gmail address from Google profile");
        // Prefer Gmail profile email; do not call oauth2 userinfo (needs extra scopes).
        const googleUserId = null;
        const encryptedRefreshToken = encryptBrokerRefreshToken(refreshToken);

        const data = {
            brokerId,
            userId,
            gmailAddress: email.toLowerCase(),
            googleUserId,
            refreshToken: encryptedRefreshToken,
            historyId: profile.data.historyId || null,
            connectedAt: new Date(),
            status: "CONNECTED",
            isActive: true,
            lastError: null,
        };
        const saved = existing
            ? await prisma.brokerGmailAccount.update({
                  where: { brokerGmailId: existing.brokerGmailId },
                  data,
              })
            : await prisma.brokerGmailAccount.create({
                  data: {
                      ...data,
                  },
              });

        console.log(
            `[BROKER GMAIL] Connected ${email} → employee ${brokerId}, user ${user.username} (${userId})`
        );
        // Warm shared client with the new token only.
        this.getSharedAuthedClient({
            brokerGmailId: saved.brokerGmailId,
            refreshToken: saved.refreshToken,
        });
        return { email, account: saved };
    }

    async getAccount(userId: string) {
        const user = await prisma.user.findUnique({
            where: { userId },
            select: { employeeId: true },
        });
        if (!user) return null;
        const account = await prisma.brokerGmailAccount.findFirst({
            where: {
                OR: [
                    { userId },
                    ...(user.employeeId ? [{ brokerId: user.employeeId }] : []),
                ],
            },
        });
        if (account && !account.brokerId && user.employeeId) {
            return prisma.brokerGmailAccount.update({
                where: { brokerGmailId: account.brokerGmailId },
                data: { brokerId: user.employeeId },
            });
        }
        return account;
    }

    getAccountByBrokerId(brokerId: string) {
        return prisma.brokerGmailAccount.findUnique({ where: { brokerId } });
    }

    async disconnect(userId: string) {
        const existing = await this.getAccount(userId);
        if (!existing) return null;
        this.invalidateBrokerClient(existing.brokerGmailId);
        try {
            const oauth2 = createOAuthClient();
            await oauth2.revokeToken(decryptBrokerRefreshToken(existing.refreshToken));
        } catch (err) {
            console.warn(
                "[BROKER GMAIL] Google token revocation failed:",
                err instanceof Error ? err.message : err
            );
        }
        return prisma.brokerGmailAccount.update({
            where: { brokerGmailId: existing.brokerGmailId },
            data: {
                status: "DISCONNECTED",
                isActive: false,
                refreshToken: "",
                historyId: null,
                lastError: null,
            },
        });
    }

    listActiveAccounts() {
        return prisma.brokerGmailAccount.findMany({
            where: {
                status: "CONNECTED",
                isActive: true,
                brokerId: { not: null },
                NOT: { refreshToken: "" },
            },
            include: {
                user: { select: { userId: true, username: true, firstName: true, lastName: true, roleId: true } },
            },
        });
    }

    /**
     * Build a shareable invite URL. The broker opens it while signed into the
     * personal Gmail that receives uShip updates — Owner never needs their password.
     */
    async createInviteUrl(userId: string): Promise<{
        inviteUrl: string;
        expiresInHours: number;
        brokerName: string;
        employeeId: string;
    }> {
        if (!this.isClientConfigured()) {
            throw Object.assign(new Error("Gmail OAuth client is not configured"), { status: 503 });
        }
        const user = await prisma.user.findUnique({
            where: { userId },
            include: { role: true, employee: true },
        });
        if (!user || !user.isActive || user.role.roleName !== "Broker") {
            throw Object.assign(new Error("Broker not found"), { status: 404 });
        }
        if (!user.employeeId || !user.employee) {
            throw Object.assign(
                new Error("Broker must be linked to an Attendance employee before connecting Gmail"),
                { status: 400 }
            );
        }
        const token = encodeBrokerGmailInvite(user.userId, user.employeeId);
        const inviteUrl = `${config.publicAppUrl}/api/email/broker/connect-invite?token=${encodeURIComponent(token)}`;
        const brokerName = `${user.firstName} ${user.lastName}`.trim() || user.username;
        return {
            inviteUrl,
            expiresInHours: 48,
            brokerName,
            employeeId: user.employeeId,
        };
    }
}

export const brokerGmailOAuthService = new BrokerGmailOAuthService();
