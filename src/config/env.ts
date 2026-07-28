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

function normalizeEmail(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * Mail architecture:
 *
 * 1) GMAIL_* — read inbox for uShip import (effiegreenlogistics@gmail.com).
 *    Also the Owner’s day-to-day Gmail for opening approval links.
 * 2) APPROVAL_EMAIL — To: for signup approval notices (default: same as #1, effie).
 * 3) SMTP_* — From: outbound sender only (App Password). Prefer a system mailbox
 *    (e.g. osgreenlogistics@gmail.com); do not require Gmail API on SMTP.
 *
 * GMAIL_USER and APPROVAL_EMAIL may be the same inbox. Prefer SMTP_USER ≠ GMAIL_USER.
 */
const smtpUser = process.env.SMTP_USER || "";
const smtpFrom = process.env.SMTP_FROM || smtpUser || "noreply@greengrouplogistics.com";
const gmailUser = process.env.GMAIL_USER || "";
/** Owner inbox: registration Approve/Reject emails land here (open in Gmail). */
const approvalEmail = process.env.APPROVAL_EMAIL || "effiegreenlogistics@gmail.com";

const smtpUserNorm = normalizeEmail(smtpUser);
const gmailUserNorm = normalizeEmail(gmailUser);
if (gmailUserNorm && smtpUserNorm && gmailUserNorm === smtpUserNorm) {
    console.warn(
        "[config] GMAIL_USER and SMTP_USER are the same. " +
            "OK for small setups, but prefer SMTP_* on a system mailbox and keep GMAIL_* for reading."
    );
}

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
    /** To: signup approval notices — Owner opens this Gmail and clicks Approve. */
    approvalEmail,
    /** From: outbound SMTP (registration notices, future system mail). */
    smtp: {
        host: process.env.SMTP_HOST || "",
        port: parseInt(process.env.SMTP_PORT || "587", 10),
        user: smtpUser,
        pass: process.env.SMTP_PASS || "",
        from: smtpFrom,
    },
    /** Gmail API: poll uShip (and future boards) from this inbox. */
    gmail: {
        clientId: process.env.GMAIL_CLIENT_ID || "",
        clientSecret: process.env.GMAIL_CLIENT_SECRET || "",
        refreshToken: process.env.GMAIL_REFRESH_TOKEN || "",
        user: gmailUser,
        processedLabelId: process.env.GMAIL_PROCESSED_LABEL_ID || "",
        redirectUri:
            process.env.GMAIL_REDIRECT_URI ||
            `${(process.env.PUBLIC_APP_URL || "http://localhost:3847").replace(/\/$/, "")}/api/email/callback`,
    },
    emailPollIntervalMs: parseInt(process.env.EMAIL_POLL_INTERVAL_MS || "30000", 10),
    /** GreenOS AI Assistant (OpenAI). */
    openai: {
        apiKey: (process.env.OPENAI_API_KEY || "").trim(),
        model: (process.env.OPENAI_MODEL || "gpt-5.5").trim(),
    },
};
