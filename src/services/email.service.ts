import nodemailer from "nodemailer";
import { google } from "googleapis";
import { config } from "../config/env.js";
import { gmailOAuthService } from "../modules/email/gmail/gmail-oauth.service.js";

function friendlySmtpError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    if (/Invalid login|BadCredentials|535/i.test(raw)) {
        return (
            "Gmail rejected SMTP login. Set SMTP_PASS to a Google App Password, " +
            "or connect Gmail OAuth (effie) so approvals can send via Gmail API. " +
            "https://support.google.com/accounts/answer/185833"
        );
    }
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(raw)) {
        return "Cannot reach the SMTP server. Check SMTP_HOST and SMTP_PORT.";
    }
    return raw;
}

function encodeSubject(subject: string): string {
    if (/^[\x20-\x7E]*$/.test(subject)) return subject;
    return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function buildRawMime(options: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
}): string {
    const boundary = `greenos_${Date.now()}`;
    const raw = [
        `From: ${options.from}`,
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

    return Buffer.from(raw)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

async function sendViaSmtp(options: {
    to: string;
    subject: string;
    text: string;
    html: string;
}): Promise<void> {
    if (!config.smtp.host || !config.smtp.user || !config.smtp.pass) {
        throw new Error("SMTP is not configured (SMTP_HOST / SMTP_USER / SMTP_PASS)");
    }

    const transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.port === 465,
        auth: {
            user: config.smtp.user,
            pass: config.smtp.pass,
        },
    });

    await transporter.sendMail({
        from: config.smtp.from,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
    });
}

/** Send using connected Gmail OAuth (effie) — no App Password required. */
async function sendViaGmailApi(options: {
    to: string;
    subject: string;
    text: string;
    html: string;
}): Promise<void> {
    if (!gmailOAuthService.isClientConfigured()) {
        throw new Error("Gmail OAuth client is not configured (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET)");
    }

    const refreshToken = await gmailOAuthService.getStoredRefreshToken();
    if (!refreshToken) {
        throw new Error(
            "Gmail is not connected. Open /api/email/auth while logged into effiegreenlogistics@gmail.com"
        );
    }

    const from =
        (await gmailOAuthService.getStoredUser()) ||
        config.gmail.user ||
        "me";

    const oauth2 = new google.auth.OAuth2(
        config.gmail.clientId,
        config.gmail.clientSecret,
        config.gmail.redirectUri
    );
    oauth2.setCredentials({ refresh_token: refreshToken });

    const gmail = google.gmail({ version: "v1", auth: oauth2 });
    await gmail.users.messages.send({
        userId: "me",
        requestBody: {
            raw: buildRawMime({
                from,
                to: options.to,
                subject: options.subject,
                text: options.text,
                html: options.html,
            }),
        },
    });
}

/**
 * Outbound system mail.
 * Prefer SMTP when credentials work; fall back to Gmail API (connected effie OAuth)
 * so registration approvals still reach APPROVAL_EMAIL when App Password is wrong.
 */
export async function sendMail(options: {
    to: string;
    subject: string;
    text: string;
    html: string;
}) {
    const smtpReady = Boolean(config.smtp.host && config.smtp.user && config.smtp.pass);
    let smtpError: unknown;

    if (smtpReady) {
        try {
            await sendViaSmtp(options);
            console.log(`[mail] Sent via SMTP to ${options.to}`);
            return;
        } catch (err) {
            smtpError = err;
            console.error("[mail] SMTP failed, trying Gmail API fallback:", err);
        }
    }

    try {
        await sendViaGmailApi(options);
        console.log(`[mail] Sent via Gmail API to ${options.to}`);
        return;
    } catch (gmailErr) {
        console.error("[mail] Gmail API send failed:", gmailErr);
        const smtpPart = smtpError
            ? friendlySmtpError(smtpError)
            : smtpReady
              ? ""
              : "SMTP not configured.";
        const gmailPart = gmailErr instanceof Error ? gmailErr.message : String(gmailErr);
        throw new Error(
            `Approval email could not be sent. ${smtpPart ? smtpPart + " " : ""}${gmailPart}`.trim()
        );
    }
}
