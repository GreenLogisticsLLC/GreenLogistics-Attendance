import fs from "fs";
import path from "path";
import { google } from "googleapis";
import { config } from "../../../config/env.js";
import { prisma } from "../../../config/database.js";

const GMAIL_CATEGORY = "gmail";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export function getGmailRedirectUri(): string {
    return config.gmail.redirectUri;
}

function createOAuthClient() {
    return new google.auth.OAuth2(
        config.gmail.clientId,
        config.gmail.clientSecret,
        getGmailRedirectUri()
    );
}

async function upsertGmailSetting(key: string, value: string, description: string) {
    await prisma.setting.upsert({
        where: { category_settingKey: { category: GMAIL_CATEGORY, settingKey: key } },
        update: { settingValue: value },
        create: {
            category: GMAIL_CATEGORY,
            settingKey: key,
            settingValue: value,
            description,
        },
    });
}

function tryPersistRefreshTokenToEnv(refreshToken: string) {
    try {
        const envPath = path.resolve(process.cwd(), ".env");
        if (!fs.existsSync(envPath)) return;
        let content = fs.readFileSync(envPath, "utf8");
        if (/^GMAIL_REFRESH_TOKEN=/m.test(content)) {
            content = content.replace(
                /^GMAIL_REFRESH_TOKEN=.*$/m,
                `GMAIL_REFRESH_TOKEN=${refreshToken}`
            );
        } else {
            content += `\nGMAIL_REFRESH_TOKEN=${refreshToken}\n`;
        }
        fs.writeFileSync(envPath, content, "utf8");
    } catch (err) {
        console.warn("[GMAIL OAUTH] Could not write refresh token to .env:", err);
    }
}

export class GmailOAuthService {
    isClientConfigured(): boolean {
        return Boolean(config.gmail.clientId && config.gmail.clientSecret);
    }

    getAuthUrl(): string {
        if (!this.isClientConfigured()) {
            throw new Error("Gmail OAuth client is not configured (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET)");
        }
        const oauth2 = createOAuthClient();
        return oauth2.generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            scope: [GMAIL_SCOPE],
            include_granted_scopes: true,
        });
    }

    async getStoredRefreshToken(): Promise<string> {
        const row = await prisma.setting.findUnique({
            where: {
                category_settingKey: {
                    category: GMAIL_CATEGORY,
                    settingKey: "refresh_token",
                },
            },
        });
        return row?.settingValue || config.gmail.refreshToken || "";
    }

    async getStoredUser(): Promise<string> {
        const row = await prisma.setting.findUnique({
            where: {
                category_settingKey: {
                    category: GMAIL_CATEGORY,
                    settingKey: "user",
                },
            },
        });
        return row?.settingValue || config.gmail.user || "";
    }

    /** Apply tokens in-memory so the listener can use them without restart. */
    applyRuntimeCredentials(refreshToken: string, user?: string) {
        config.gmail.refreshToken = refreshToken;
        if (user) config.gmail.user = user;
    }

    async exchangeCodeAndSave(code: string): Promise<{ email: string }> {
        if (!this.isClientConfigured()) {
            throw new Error("Gmail OAuth client is not configured");
        }
        if (!code) {
            throw new Error("Missing authorization code");
        }

        const oauth2 = createOAuthClient();
        const { tokens } = await oauth2.getToken(code);
        if (!tokens.refresh_token) {
            throw new Error(
                "Google did not return a refresh_token. Revoke prior access in Google Account and try again with prompt=consent."
            );
        }

        oauth2.setCredentials(tokens);
        const gmail = google.gmail({ version: "v1", auth: oauth2 });
        const profile = await gmail.users.getProfile({ userId: "me" });
        const email = profile.data.emailAddress || config.gmail.user || "";

        await upsertGmailSetting(
            "refresh_token",
            tokens.refresh_token,
            "Gmail OAuth refresh token"
        );
        if (tokens.access_token) {
            await upsertGmailSetting(
                "access_token",
                tokens.access_token,
                "Gmail OAuth access token (short-lived)"
            );
        }
        if (email) {
            await upsertGmailSetting("user", email, "Connected Gmail mailbox");
        }
        await upsertGmailSetting(
            "connected_at",
            new Date().toISOString(),
            "When Gmail OAuth was last connected"
        );

        this.applyRuntimeCredentials(tokens.refresh_token, email || undefined);
        tryPersistRefreshTokenToEnv(tokens.refresh_token);

        console.log(`[GMAIL OAUTH] Connected successfully as ${email || "(unknown)"}`);
        return { email };
    }
}

export const gmailOAuthService = new GmailOAuthService();
