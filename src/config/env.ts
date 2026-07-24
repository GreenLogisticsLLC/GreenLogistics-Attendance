import dotenv from "dotenv";

dotenv.config();

function parseCorsOrigins(): string[] {
    const raw = process.env.CORS_ORIGINS || "";
    const fromEnv = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (fromEnv.length) return fromEnv;
    return [
        "https://greengrouplogistics.com",
        "https://www.greengrouplogistics.com",
        "https://os.greengrouplogistics.com",
        "http://localhost:3847",
    ];
}

const smtpUser = process.env.SMTP_USER || "";
const smtpFrom = process.env.SMTP_FROM || smtpUser || "noreply@greengrouplogistics.com";

export const config = {
    port: parseInt(process.env.PORT || process.env.API_PORT || "3847", 10),
    host: process.env.API_HOST || "0.0.0.0",
    jwtSecret: process.env.JWT_SECRET || "dev-secret-change-in-production",
    webhookSecret: process.env.WEBHOOK_SECRET || "webhook-dev-secret",
    timezone: process.env.TIMEZONE || "America/Los_Angeles",
    companyName: process.env.COMPANY_NAME || "Green Logistics",
    legacyApiUrl: process.env.LEGACY_API_URL || "",
    legacyIngestToken: process.env.LEGACY_INGEST_TOKEN || "",
    corsOrigins: parseCorsOrigins(),
    publicAppUrl: (process.env.PUBLIC_APP_URL || "http://localhost:3847").replace(/\/$/, ""),
    approvalEmail: process.env.APPROVAL_EMAIL || "osgreenlogistics@gmail.com",
    smtp: {
        host: process.env.SMTP_HOST || "",
        port: parseInt(process.env.SMTP_PORT || "587", 10),
        user: smtpUser,
        pass: process.env.SMTP_PASS || "",
        from: smtpFrom,
    },
    gmail: {
        clientId: process.env.GMAIL_CLIENT_ID || "",
        clientSecret: process.env.GMAIL_CLIENT_SECRET || "",
        refreshToken: process.env.GMAIL_REFRESH_TOKEN || "",
        user: process.env.GMAIL_USER || "",
        processedLabelId: process.env.GMAIL_PROCESSED_LABEL_ID || "",
        redirectUri:
            process.env.GMAIL_REDIRECT_URI ||
            `${(process.env.PUBLIC_APP_URL || "http://localhost:3847").replace(/\/$/, "")}/api/email/callback`,
    },
    emailPollIntervalMs: parseInt(process.env.EMAIL_POLL_INTERVAL_MS || "30000", 10),
};
