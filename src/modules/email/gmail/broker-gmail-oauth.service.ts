import { google } from "googleapis";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { config } from "../../../config/env.js";
import { prisma } from "../../../config/database.js";
import { getGmailRedirectUri } from "./gmail-oauth.service.js";

const BROKER_GMAIL_SCOPES = [
    "openid",
    "email",
    "https://www.googleapis.com/auth/gmail.readonly",
];
const TOKEN_PREFIX = "enc:v1:";

type BrokerOAuthState = {
    purpose: "broker-gmail";
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

function createOAuthClient() {
    return new google.auth.OAuth2(
        config.gmail.clientId,
        config.gmail.clientSecret,
        getGmailRedirectUri()
    );
}

export class BrokerGmailOAuthService {
    isClientConfigured(): boolean {
        return Boolean(config.gmail.clientId && config.gmail.clientSecret);
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
            include_granted_scopes: true,
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
        const refreshToken = tokens.refresh_token || (existing?.refreshToken
            ? decryptBrokerRefreshToken(existing.refreshToken)
            : "");
        if (!refreshToken) {
            throw new Error(
                "Google did not return a refresh_token. Revoke prior access in Google Account and reconnect with consent."
            );
        }

        oauth2.setCredentials(tokens);
        const gmail = google.gmail({ version: "v1", auth: oauth2 });
        const profile = await gmail.users.getProfile({ userId: "me" });
        const email = profile.data.emailAddress || "";
        if (!email) throw new Error("Could not read Gmail address from Google profile");
        const oauthProfile = await google.oauth2({ version: "v2", auth: oauth2 }).userinfo.get();
        const googleUserId = oauthProfile.data.id || null;
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
}

export const brokerGmailOAuthService = new BrokerGmailOAuthService();
