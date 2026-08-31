import fs from "fs";
import path from "path";
import { google } from "googleapis";
import jwt from "jsonwebtoken";
import { config } from "../../../config/env.js";
import { prisma } from "../../../config/database.js";

const GMAIL_CATEGORY = "gmail";
const GMAIL_SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
];

let warnedStaleEnvToken = false;

type CompanyOAuthState = {
    purpose: "company-gmail";
    userId: string;
};

export function parseCompanyOAuthState(state: string | undefined | null): CompanyOAuthState | null {
    if (!state) return null;
    try {
        const payload = jwt.verify(state, config.jwtSecret) as CompanyOAuthState;
        return payload.purpose === "company-gmail" && payload.userId ? payload : null;
    } catch {
        return null;
    }
}

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

function tokenFingerprint(refreshToken: string): string {
    const value = (refreshToken || "").trim();
    if (!value) return "empty";
    return `len=${value.length} prefix=${value.slice(0, 6)}…suffix=${value.slice(-4)}`;
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
        // Keep env GMAIL_USER aligned when present so boot-time config cannot
        // look "configured" with a stale mailbox identity.
        fs.writeFileSync(envPath, content, "utf8");
    } catch (err) {
        console.warn("[GMAIL OAUTH] Could not write refresh token to .env:", err);
    }
}

export class GmailOAuthService {
    /** One shared company OAuth2 client — reuse access tokens; drop on reconnect / rotation. */
    private companyAuth: {
        refreshToken: string;
        oauth2: ReturnType<typeof createOAuthClient>;
    } | null = null;

    isClientConfigured(): boolean {
        return Boolean(config.gmail.clientId && config.gmail.clientSecret);
    }

    getAuthUrl(userId = "company"): string {
        if (!this.isClientConfigured()) {
            throw new Error("Gmail OAuth client is not configured (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET)");
        }
        const oauth2 = createOAuthClient();
        return oauth2.generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            scope: GMAIL_SCOPES,
            include_granted_scopes: true,
            state: jwt.sign(
                {
                    purpose: "company-gmail",
                    userId: userId || "company",
                } satisfies CompanyOAuthState,
                config.jwtSecret,
                { expiresIn: "10m" }
            ),
        });
    }

    /**
     * Company refresh token source of truth is settings (category=gmail).
     * .env / process env is only a boot-time fallback and is rewritten on OAuth.
     */
    async getStoredRefreshToken(): Promise<{ token: string; source: "settings" | "env" | "none" }> {
        const row = await prisma.setting.findUnique({
            where: {
                category_settingKey: {
                    category: GMAIL_CATEGORY,
                    settingKey: "refresh_token",
                },
            },
        });
        const fromSettings = (row?.settingValue || "").trim();
        if (fromSettings) {
            const fromEnv = (config.gmail.refreshToken || "").trim();
            if (fromEnv && fromEnv !== fromSettings) {
                if (!warnedStaleEnvToken) {
                    warnedStaleEnvToken = true;
                    console.warn(
                        `[GMAIL OAUTH] Stale .env refresh token ignored (settings ${tokenFingerprint(fromSettings)} != env ${tokenFingerprint(fromEnv)}); aligning .env to settings`
                    );
                }
                // Keep runtime + .env aligned with settings so a later restart
                // cannot revive the revoked token.
                this.applyRuntimeCredentials(fromSettings);
                tryPersistRefreshTokenToEnv(fromSettings);
            }
            return { token: fromSettings, source: "settings" };
        }
        const fromEnv = (config.gmail.refreshToken || "").trim();
        if (fromEnv) return { token: fromEnv, source: "env" };
        return { token: "", source: "none" };
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

    /** Drop cached company client (after reconnect or invalid_grant). */
    invalidateCompanyClient() {
        this.companyAuth = null;
    }

    private async persistRotatedTokens(tokens: {
        refresh_token?: string | null;
        access_token?: string | null;
    }) {
        if (tokens.refresh_token) {
            await upsertGmailSetting(
                "refresh_token",
                tokens.refresh_token,
                "Gmail OAuth refresh token"
            );
            this.applyRuntimeCredentials(tokens.refresh_token);
            tryPersistRefreshTokenToEnv(tokens.refresh_token);
            if (this.companyAuth) {
                this.companyAuth.refreshToken = tokens.refresh_token;
            }
            console.log(
                `[GMAIL OAUTH] Persisted rotated refresh token (${tokenFingerprint(tokens.refresh_token)})`
            );
        }
        if (tokens.access_token) {
            await upsertGmailSetting(
                "access_token",
                tokens.access_token,
                "Gmail OAuth access token (short-lived)"
            );
        }
    }

    /**
     * Shared company OAuth2 client.
     * Reuses access tokens across list/fetch/mark/send so we do not refresh
     * dozens of times per inbox tick (that caused intermittent invalid_grant).
     * Rebuilt when the settings refresh token changes or after invalidateCompanyClient().
     */
    getSharedAuthedClient(refreshToken: string) {
        const token = (refreshToken || "").trim();
        if (!token) {
            throw new Error("Missing Gmail refresh token");
        }
        if (this.companyAuth?.refreshToken === token) {
            return this.companyAuth.oauth2;
        }

        this.invalidateCompanyClient();
        const oauth2 = createOAuthClient();
        oauth2.setCredentials({ refresh_token: token });
        oauth2.on("tokens", (tokens) => {
            void this.persistRotatedTokens(tokens).catch((err) => {
                console.warn("[GMAIL OAUTH] Failed to persist rotated tokens:", err);
            });
        });
        this.companyAuth = { refreshToken: token, oauth2 };
        return oauth2;
    }

    /** @deprecated Prefer getSharedAuthedClient — kept for one-off non-company use. */
    createAuthedClient(refreshToken: string) {
        return this.getSharedAuthedClient(refreshToken);
    }

    async exchangeCodeAndSave(code: string): Promise<{ email: string }> {
        if (!this.isClientConfigured()) {
            throw new Error("Gmail OAuth client is not configured");
        }
        if (!code) {
            throw new Error("Missing authorization code");
        }

        // Drop any pre-reconnect client that still holds the revoked refresh token.
        this.invalidateCompanyClient();

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
        const emailNorm = (email || "").trim().toLowerCase();
        const required = (config.companyUshipImportEmail || "").trim().toLowerCase();
        if (required && emailNorm && emailNorm !== required) {
            throw new Error(
                `Wrong Gmail account (${email}). Connect ${required} for Email Imports / new uShip shipments.`
            );
        }

        // Full replace: settings + runtime + .env. Old refresh tokens are discarded.
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
        } else {
            await upsertGmailSetting("access_token", "", "Gmail OAuth access token (short-lived)");
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
        // Warm shared client with the new token only (never the old one).
        this.getSharedAuthedClient(tokens.refresh_token);

        console.log(
            `[GMAIL OAUTH] Connected successfully as ${email || "(unknown)"} (${tokenFingerprint(tokens.refresh_token)})`
        );
        return { email };
    }
}

export const gmailOAuthService = new GmailOAuthService();
