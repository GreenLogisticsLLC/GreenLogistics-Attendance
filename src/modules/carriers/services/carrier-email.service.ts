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
    }) {
        const subject = `Carrier package ready — ${input.carrierLegalName}`;
        const text = [
            `Carrier: ${input.carrierLegalName}`,
            `MC: ${input.mcNumber || "—"}`,
            `DOT: ${input.dotNumber || "—"}`,
            `Package: ${input.purposeLabel}`,
            "",
            "Received:",
            ...input.docs.map((d) => `✓ ${d}`),
            "",
            `Open in Green OS: ${input.carrierUrl}`,
            "",
            "Documents are stored in Green OS (not attached to this email).",
        ].join("\n");
        const html = `
          <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#152033;line-height:1.5">
            <h2 style="color:#059669">Carrier package ready</h2>
            <p><strong>${esc(input.carrierLegalName)}</strong></p>
            <p>MC: ${esc(input.mcNumber || "—")}<br/>DOT: ${esc(input.dotNumber || "—")}<br/>Package: <strong>${esc(
                input.purposeLabel
            )}</strong></p>
            <ul>${input.docs.map((d) => `<li>✓ ${esc(d)}</li>`).join("")}</ul>
            <p style="margin:24px 0">
              <a href="${esc(input.carrierUrl)}" style="background:#059669;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;display:inline-block;font-weight:600">
                Open Carrier in Green OS
              </a>
            </p>
          </div>`;
        // Notify broker inbox — system/company mail is fine (To = broker).
        await sendMail({ to: input.to, subject, text, html });
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
