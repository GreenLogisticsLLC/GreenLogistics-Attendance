import nodemailer from "nodemailer";
import { config } from "../config/env.js";

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

    await transporter.sendMail({
        from: config.smtp.from,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
    });
}
