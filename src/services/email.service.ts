import nodemailer from "nodemailer";
import { config } from "../config/env.js";

function friendlySmtpError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    if (/Invalid login|BadCredentials|535/i.test(raw)) {
        return (
            "Approval email could not be sent: Gmail rejected SMTP login. " +
            "On the server set SMTP_USER to the Gmail address and SMTP_PASS to a Google App Password " +
            "(not the normal Gmail password). See https://support.google.com/accounts/answer/185833"
        );
    }
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(raw)) {
        return "Approval email could not be sent: cannot reach the mail server. Check SMTP_HOST and SMTP_PORT.";
    }
    return `Approval email could not be sent: ${raw}`;
}

export async function sendMail(options: {
    to: string;
    subject: string;
    text: string;
    html: string;
}) {
    if (!config.smtp.host || !config.smtp.user || !config.smtp.pass) {
        throw new Error(
            "Email is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS on the server."
        );
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

    try {
        await transporter.sendMail({
            from: config.smtp.from,
            to: options.to,
            subject: options.subject,
            text: options.text,
            html: options.html,
        });
    } catch (err) {
        console.error("[SMTP] sendMail failed:", err);
        throw new Error(friendlySmtpError(err));
    }
}
