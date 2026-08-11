import { config } from "../../../config/env.js";
import { sendMail } from "../../../services/email.service.js";
import { brokerGmailOAuthService } from "../../email/gmail/broker-gmail-oauth.service.js";

function esc(s: string): string {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export class CarrierEmailService {
    /**
     * Prefer sending FROM the assigned broker's connected Gmail TO the carrier.
     * Falls back to system mail only when allowSystemFallback=true.
     */
    async sendAsBrokerOrSystem(input: {
        brokerUserId?: string | null;
        to: string;
        subject: string;
        text: string;
        html: string;
        allowSystemFallback?: boolean;
    }): Promise<{ from: string; via: "broker-gmail" | "system" }> {
        if (input.brokerUserId) {
            try {
                const sent = await brokerGmailOAuthService.sendMailAsBroker(input.brokerUserId, {
                    to: input.to,
                    subject: input.subject,
                    text: input.text,
                    html: input.html,
                });
                return { from: sent.from, via: "broker-gmail" };
            } catch (err) {
                if (!input.allowSystemFallback) throw err;
            }
        }
        if (!input.allowSystemFallback) {
            throw Object.assign(
                new Error(
                    "Broker Gmail is required to email the carrier. Connect Gmail in My Workspace first."
                ),
                { status: 400, code: "BROKER_GMAIL_REQUIRED" }
            );
        }
        await sendMail({
            to: input.to,
            subject: input.subject,
            text: input.text,
            html: input.html,
        });
        return { from: config.smtp.from || config.gmail.user || "system", via: "system" };
    }

    async sendAgreementInvite(input: {
        brokerUserId: string;
        to: string;
        contactName: string;
        carrierLegalName: string;
        onboardingUrl: string;
        brokerName?: string;
        loadNumber?: string | null;
    }) {
        const name = input.contactName || "Carrier Partner";
        const subject = "Green Logistics — Carrier-Broker Agreement & Documents";
        const text = [
            `Hello ${name},`,
            "",
            "Green Logistics is requesting your carrier profile, signed Broker-Carrier Agreement, and required documents (MC Authority, NOA, W-9).",
            input.loadNumber ? `Load: ${input.loadNumber}` : "",
            "",
            "Open your secure link:",
            input.onboardingUrl,
            "",
            "After you save/submit, your package is stored in Green OS and your broker is notified.",
            "",
            "Thank you,",
            input.brokerName || "Green Logistics",
        ]
            .filter(Boolean)
            .join("\n");

        const html = `
          <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#152033;line-height:1.5">
            <h2 style="color:#059669;margin:0 0 12px">Green Logistics</h2>
            <p>Hello ${esc(name)},</p>
            <p>Please complete your <strong>Carrier-Broker Agreement</strong> package for <strong>${esc(input.carrierLegalName)}</strong>${
                input.loadNumber ? ` (Load <strong>${esc(input.loadNumber)}</strong>)` : ""
            }.</p>
            <p>You will:</p>
            <ul>
              <li>Review / complete company information</li>
              <li>Read and sign the Broker-Carrier Agreement</li>
              <li>Upload MC Authority, NOA, and W-9</li>
            </ul>
            <p style="margin:24px 0">
              <a href="${esc(input.onboardingUrl)}" style="background:#059669;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;display:inline-block;font-weight:600">
                Open Secure Onboarding
              </a>
            </p>
            <p style="color:#5b6b84;font-size:14px">Do not forward this link. It is a secure credential for your company only.</p>
            <p>Thank you,<br/>${esc(input.brokerName || "Green Logistics")}</p>
          </div>`;

        return this.sendAsBrokerOrSystem({
            brokerUserId: input.brokerUserId,
            to: input.to,
            subject,
            text,
            html,
            allowSystemFallback: false,
        });
    }

    async sendRcBolInvite(input: {
        brokerUserId: string;
        to: string;
        contactName: string;
        carrierLegalName: string;
        onboardingUrl: string;
        brokerName?: string;
        loadNumber?: string | null;
    }) {
        const name = input.contactName || "Carrier Partner";
        const subject = `Green Logistics — Review & Sign RC / BOL${
            input.loadNumber ? ` (${input.loadNumber})` : ""
        }`;
        const text = [
            `Hello ${name},`,
            "",
            "Your Rate Confirmation and Bill of Lading are ready for review in Green OS.",
            input.loadNumber ? `Load: ${input.loadNumber}` : "",
            "",
            "Open the secure link to review the filled RC and BOL and sign:",
            input.onboardingUrl,
            "",
            "Thank you,",
            input.brokerName || "Green Logistics",
        ]
            .filter(Boolean)
            .join("\n");

        const html = `
          <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#152033;line-height:1.5">
            <h2 style="color:#059669;margin:0 0 12px">Green Logistics</h2>
            <p>Hello ${esc(name)},</p>
            <p>Your <strong>Rate Confirmation</strong> and <strong>BOL</strong> for <strong>${esc(
                input.carrierLegalName
            )}</strong>${
                input.loadNumber ? ` (Load <strong>${esc(input.loadNumber)}</strong>)` : ""
            } are ready.</p>
            <p>Review the filled documents and click <strong>I Agree &amp; Sign</strong>.</p>
            <p style="margin:24px 0">
              <a href="${esc(input.onboardingUrl)}" style="background:#059669;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;display:inline-block;font-weight:600">
                Review RC &amp; BOL
              </a>
            </p>
            <p>Thank you,<br/>${esc(input.brokerName || "Green Logistics")}</p>
          </div>`;

        return this.sendAsBrokerOrSystem({
            brokerUserId: input.brokerUserId,
            to: input.to,
            subject,
            text,
            html,
            allowSystemFallback: false,
        });
    }

    async sendBrokerPackageReady(input: {
        to: string;
        brokerUserId?: string | null;
        carrierLegalName: string;
        mcNumber?: string | null;
        dotNumber?: string | null;
        carrierUrl: string;
        purposeLabel: string;
        docs: string[];
        /** Filled carrier profile lines shown in the email body */
        packageFields?: Array<{ label: string; value: string }>;
        signedBy?: string | null;
        signedAt?: string | null;
        replyToCarrierEmail?: string | null;
    }) {
        const fields = input.packageFields || [];
        const subject = `Carrier package completed — ${input.carrierLegalName}`;
        const fieldText = fields.map((f) => `${f.label}: ${f.value || "—"}`).join("\n");
        const text = [
            `Green Logistics — carrier package returned to broker`,
            "",
            `Package: ${input.purposeLabel}`,
            `Carrier: ${input.carrierLegalName}`,
            `MC: ${input.mcNumber || "—"}`,
            `DOT: ${input.dotNumber || "—"}`,
            input.signedBy ? `Signed by: ${input.signedBy}` : "",
            input.signedAt ? `Signed at: ${input.signedAt}` : "",
            "",
            "Filled information:",
            fieldText || "(see Green OS)",
            "",
            "Documents / checklist:",
            ...input.docs.map((d) => `✓ ${d}`),
            "",
            `Open full package in Green OS: ${input.carrierUrl}`,
            "",
            "Sensitive files (W-9, MC, NOA) are stored in Green OS — open the carrier card to download.",
        ]
            .filter((line) => line !== "")
            .join("\n");

        const fieldsHtml = fields
            .map(
                (f) =>
                    `<tr><td style="padding:6px 10px;border-bottom:1px solid #e5eaf2;color:#5b6b84;width:40%">${esc(
                        f.label
                    )}</td><td style="padding:6px 10px;border-bottom:1px solid #e5eaf2;font-weight:600">${esc(
                        f.value || "—"
                    )}</td></tr>`
            )
            .join("");

        const html = `
          <div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:0 auto;color:#152033;line-height:1.5">
            <h2 style="color:#059669;margin:0 0 8px">Carrier package completed</h2>
            <p style="margin:0 0 12px;color:#5b6b84">${esc(input.purposeLabel)}</p>
            <p><strong>${esc(input.carrierLegalName)}</strong><br/>
            MC: ${esc(input.mcNumber || "—")} · DOT: ${esc(input.dotNumber || "—")}</p>
            ${
                input.signedBy
                    ? `<p>Signed by <strong>${esc(input.signedBy)}</strong>${
                          input.signedAt ? ` · ${esc(input.signedAt)}` : ""
                      }</p>`
                    : ""
            }
            <h3 style="margin:18px 0 8px;font-size:15px">Filled carrier information</h3>
            <table style="width:100%;border-collapse:collapse;background:#f8fafc;border:1px solid #e5eaf2;border-radius:8px">${fieldsHtml}</table>
            <h3 style="margin:18px 0 8px;font-size:15px">Received</h3>
            <ul>${input.docs.map((d) => `<li>✓ ${esc(d)}</li>`).join("")}</ul>
            <p style="margin:24px 0">
              <a href="${esc(input.carrierUrl)}" style="background:#059669;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;display:inline-block;font-weight:600">
                Open filled package in Green OS
              </a>
            </p>
            <p style="color:#5b6b84;font-size:13px">MC Authority / NOA / W-9 are saved in Green OS (download from the carrier card). This email is the broker notification with the filled form data.</p>
          </div>`;

        const payload = { to: input.to, subject, text, html };
        let lastErr: unknown;

        // 1) Prefer broker Gmail → broker inbox (same mailbox they use day-to-day)
        if (input.brokerUserId) {
            try {
                await brokerGmailOAuthService.sendMailAsBroker(input.brokerUserId, payload);
                return { via: "broker-gmail" as const, to: input.to };
            } catch (err) {
                lastErr = err;
            }
        }

        // 2) Fallback: company/system mail To broker
        try {
            await sendMail(payload);
            return { via: "system" as const, to: input.to };
        } catch (err) {
            lastErr = err;
        }

        throw lastErr instanceof Error
            ? lastErr
            : Object.assign(new Error("Failed to email broker the completed package"), { status: 500 });
    }

    async sendOnboardingInvite(input: {
        to: string;
        contactName: string;
        carrierLegalName: string;
        onboardingUrl: string;
        brokerName?: string;
        brokerUserId?: string | null;
    }) {
        return this.sendAgreementInvite({
            brokerUserId: input.brokerUserId || "",
            to: input.to,
            contactName: input.contactName,
            carrierLegalName: input.carrierLegalName,
            onboardingUrl: input.onboardingUrl,
            brokerName: input.brokerName,
        });
    }

    async sendBrokerSubmissionNotice(input: {
        to: string;
        carrierLegalName: string;
        mcNumber?: string | null;
        dotNumber?: string | null;
        carrierUrl: string;
        docs: string[];
    }) {
        await this.sendBrokerPackageReady({
            ...input,
            purposeLabel: "Onboarding SUBMITTED",
        });
    }

    async sendChangeRequest(input: {
        to: string;
        contactName: string;
        carrierLegalName: string;
        reason: string;
        onboardingUrl: string;
        brokerUserId?: string | null;
        brokerName?: string;
    }) {
        const subject = `Green Logistics — Additional documents needed (${input.carrierLegalName})`;
        const text = [
            `Hello ${input.contactName || "Carrier Partner"},`,
            "",
            "Green Logistics needs a few corrections to your carrier package.",
            "",
            `Reason: ${input.reason}`,
            "",
            `Please reopen the secure link: ${input.onboardingUrl}`,
            "",
            "Thank you,",
            input.brokerName || "Green Logistics",
        ].join("\n");
        const html = `
          <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#152033;line-height:1.5">
            <h2 style="color:#059669">Additional documents needed</h2>
            <p>Hello ${esc(input.contactName || "Carrier Partner")},</p>
            <p><strong>Reason:</strong> ${esc(input.reason)}</p>
            <p style="margin:24px 0">
              <a href="${esc(input.onboardingUrl)}" style="background:#059669;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;display:inline-block;font-weight:600">
                Open Secure Onboarding
              </a>
            </p>
          </div>`;
        return this.sendAsBrokerOrSystem({
            brokerUserId: input.brokerUserId,
            to: input.to,
            subject,
            text,
            html,
            allowSystemFallback: false,
        });
    }

    carrierPortalUrl(token: string): string {
        return `${config.publicAppUrl}/carrier/onboarding/${encodeURIComponent(token)}`;
    }

    carrierRecordUrl(carrierId: string): string {
        return `${config.publicAppUrl}/?module=carriers&carrierId=${encodeURIComponent(carrierId)}`;
    }

    fallbackAdminEmail(): string {
        return config.approvalEmail || config.smtp.from || "";
    }
}

export const carrierEmailService = new CarrierEmailService();
