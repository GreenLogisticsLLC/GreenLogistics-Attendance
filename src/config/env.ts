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
 * Mail architecture (three independent roles — do not share one mailbox):
 *
 * 1) GMAIL_*     — inbound uShip import via Gmail API only (e.g. effiegreenlogistics@gmail.com)
 * 2) APPROVAL_EMAIL — Owner/admin recipient for agent signup approvals (e.g. osgreenlogistics@gmail.com)
 * 3) SMTP_*      — outbound transactional sender (App Password); never the uShip import inbox
 *
 * Backward compatible: same env var names; missing optional vars keep prior defaults.
 */
const smtpUser = process.env.SMTP_USER || "";
const smtpFrom = process.env.SMTP_FROM || smtpUser || "noreply@greengrouplogistics.com";
const gmailUser = process.env.GMAIL_USER || "";
const approvalEmail = process.env.APPROVAL_EMAIL || "osgreenlogistics@gmail.com";

const smtpUserNorm = normalizeEmail(smtpUser);
const gmailUserNorm = normalizeEmail(gmailUser);
if (gmailUserNorm && smtpUserNorm && gmailUserNorm === smtpUserNorm) {
    console.warn(
        "[config] GMAIL_USER and SMTP_USER point to the same mailbox. " +
            "Keep them separate: GMAIL_USER = uShip import only; SMTP_* = outbound mail."
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
    /** Role 2: who receives signup approval requests (not the SMTP From, not the uShip inbox). */
    approvalEmail,
    /** Role 3: outbound SMTP for system emails (approvals, etc.). */
    smtp: {
        host: process.env.SMTP_HOST || "",
        port: parseInt(process.env.SMTP_PORT || "587", 10),
        user: smtpUser,
        pass: process.env.SMTP_PASS || "",
        from: smtpFrom,
    },
    /** Role 1: Gmail API inbox for uShip (and future load-board) email import only. */
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
};
