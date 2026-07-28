import { google } from "googleapis";
import { config } from "../../../config/env.js";
import { prisma } from "../../../config/database.js";
import { getGmailRedirectUri } from "./gmail-oauth.service.js";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const BROKER_STATE_PREFIX = "broker:";

export function encodeBrokerOAuthState(userId: string): string {
    return `${BROKER_STATE_PREFIX}${userId}`;
}

export function parseBrokerOAuthState(state: string | undefined | null): string | null {
    if (!state || !state.startsWith(BROKER_STATE_PREFIX)) return null;
    const userId = state.slice(BROKER_STATE_PREFIX.length).trim();
    return userId || null;
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

    getAuthUrlForBroker(userId: string): string {
        if (!this.isClientConfigured()) {
            throw new Error("Gmail OAuth client is not configured");
        }
        const oauth2 = createOAuthClient();
        return oauth2.generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            scope: [GMAIL_SCOPE],
            include_granted_scopes: true,
            state: encodeBrokerOAuthState(userId),
        });
    }

    async exchangeCodeAndSaveForBroker(userId: string, code: string) {
        if (!this.isClientConfigured()) {
            throw new Error("Gmail OAuth client is not configured");
        }
        if (!code) throw new Error("Missing authorization code");

        const user = await prisma.user.findUnique({ where: { userId } });
        if (!user || !user.isActive) {
            throw Object.assign(new Error("User not found or inactive"), { status: 404 });
        }

        const oauth2 = createOAuthClient();
        const { tokens } = await oauth2.getToken(code);
        if (!tokens.refresh_token) {
            throw new Error(
                "Google did not return a refresh_token. Revoke prior access in Google Account and reconnect with consent."
            );
        }

        oauth2.setCredentials(tokens);
        const gmail = google.gmail({ version: "v1", auth: oauth2 });
        const profile = await gmail.users.getProfile({ userId: "me" });
        const email = profile.data.emailAddress || "";
        if (!email) throw new Error("Could not read Gmail address from Google profile");

        const saved = await prisma.brokerGmailAccount.upsert({
            where: { userId },
            create: {
                userId,
                gmailAddress: email,
                refreshToken: tokens.refresh_token,
                accessToken: tokens.access_token || null,
                connectedAt: new Date(),
                isActive: true,
                lastError: null,
            },
            update: {
                gmailAddress: email,
                refreshToken: tokens.refresh_token,
                accessToken: tokens.access_token || null,
                connectedAt: new Date(),
                isActive: true,
                lastError: null,
            },
        });

        console.log(`[BROKER GMAIL] Connected ${email} → user ${user.username} (${userId})`);
        return { email, account: saved };
    }

    getAccount(userId: string) {
        return prisma.brokerGmailAccount.findUnique({ where: { userId } });
    }

    async disconnect(userId: string) {
        const existing = await prisma.brokerGmailAccount.findUnique({ where: { userId } });
        if (!existing) return null;
        return prisma.brokerGmailAccount.update({
            where: { userId },
            data: { isActive: false, refreshToken: "", accessToken: null, lastError: "Disconnected by user" },
        });
    }

    listActiveAccounts() {
        return prisma.brokerGmailAccount.findMany({
            where: { isActive: true, NOT: { refreshToken: "" } },
            include: {
                user: { select: { userId: true, username: true, firstName: true, lastName: true, roleId: true } },
            },
        });
    }
}

export const brokerGmailOAuthService = new BrokerGmailOAuthService();
