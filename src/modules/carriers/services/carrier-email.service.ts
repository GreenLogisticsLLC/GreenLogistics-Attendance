import { config } from "../../../config/env.js";
import { sendMail } from "../../../services/email.service.js";

function esc(s: string): string {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export class CarrierEmailService {
    async sendOnboardingInvite(input: {
        to: string;
        contactName: string;
        carrierLegalName: string;
        onboardingUrl: string;
        brokerName?: string;
    }) {
        const name = input.contactName || "Carrier Partner";
        const subject = "Green Logistics — Carrier Onboarding";
        const text = [
            `Hello ${name},`,
            "",
            "Green Logistics is requesting your carrier information and required documents to complete the carrier onboarding process.",
            "",
            `Please use the secure link below to complete your onboarding:`,
            input.onboardingUrl,
            "",
            "You will be asked to provide carrier information, review/sign the Carrier-Broker Agreement, and upload the required documents.",
            "",
            "Required documents may include:",
            "- MC Authority",
            "- NOA",
            "- W-9",
            "- Rate Confirmation / RC (when a load is linked)",
            "- Carrier-Broker Agreement",
            "",
            "If you have questions, please contact your Green Logistics representative.",
            "",
            "Thank you,",
            "Green Logistics",
        ].join("\n");

        const html = `
          <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#152033;line-height:1.5">
            <h2 style="color:#059669;margin:0 0 12px">Green Logistics</h2>
            <p>Hello ${esc(name)},</p>
            <p>Green Logistics is requesting your carrier information and required documents to complete the carrier onboarding process for <strong>${esc(input.carrierLegalName)}</strong>.</p>
            <p style="margin:24px 0">
              <a href="${esc(input.onboardingUrl)}" style="background:#059669;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;display:inline-block;font-weight:600">
                Complete Carrier Onboarding
              </a>
            </p>
            <p>You will be asked to provide carrier information, review/sign the Carrier-Broker Agreement, and upload the required documents.</p>
            <p style="color:#5b6b84;font-size:14px">Do not forward this link. It is a secure credential for your company only.</p>
            <p>Thank you,<br/>Green Logistics${input.brokerName ? `<br/><span style="color:#5b6b84">Your broker: ${esc(input.brokerName)}</span>` : ""}</p>
          </div>`;

        await sendMail({ to: input.to, subject, text, html });
    }

    async sendBrokerSubmissionNotice(input: {
        to: string;
        carrierLegalName: string;
        mcNumber?: string | null;
        dotNumber?: string | null;
        carrierUrl: string;
        docs: string[];
    }) {
        const subject = `Carrier Onboarding Completed — ${input.carrierLegalName}`;
        const docLines = input.docs.map((d) => `✓ ${d}`).join("\n");
        const text = [
            `Carrier: ${input.carrierLegalName}`,
            `MC: ${input.mcNumber || "—"}`,
            `DOT: ${input.dotNumber || "—"}`,
            "Status: SUBMITTED",
            "",
            "Documents received:",
            docLines || "(see Green OS)",
            "",
            `Open Carrier: ${input.carrierUrl}`,
            "",
            "Sensitive documents are stored in Green OS — not attached to this email.",
        ].join("\n");

        const html = `
          <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#152033;line-height:1.5">
            <h2 style="color:#059669;margin:0 0 12px">Carrier Onboarding Completed</h2>
            <p><strong>${esc(input.carrierLegalName)}</strong></p>
            <p>MC: ${esc(input.mcNumber || "—")}<br/>DOT: ${esc(input.dotNumber || "—")}<br/>Status: <strong>SUBMITTED</strong></p>
            <p>Documents received:</p>
            <ul>${input.docs.map((d) => `<li>✓ ${esc(d)}</li>`).join("")}</ul>
            <p style="margin:24px 0">
              <a href="${esc(input.carrierUrl)}" style="background:#059669;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;display:inline-block;font-weight:600">
                Open Carrier in Green OS
              </a>
            </p>
            <p style="color:#5b6b84;font-size:14px">Documents are not attached. Open Green OS to review the package.</p>
          </div>`;

        await sendMail({ to: input.to, subject, text, html });
    }

    async sendChangeRequest(input: {
        to: string;
        contactName: string;
        carrierLegalName: string;
        reason: string;
        onboardingUrl: string;
    }) {
        const subject = `Green Logistics — Additional documents needed (${input.carrierLegalName})`;
        const text = [
            `Hello ${input.contactName || "Carrier Partner"},`,
            "",
            "Green Logistics needs a few corrections to your carrier onboarding package.",
            "",
            `Reason: ${input.reason}`,
            "",
            `Please reopen the secure link: ${input.onboardingUrl}`,
            "",
            "Previous uploads remain archived. Upload replacements as needed.",
            "",
            "Thank you,",
            "Green Logistics",
        ].join("\n");
        const html = `
          <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#152033;line-height:1.5">
            <h2 style="color:#059669">Additional documents needed</h2>
            <p>Hello ${esc(input.contactName || "Carrier Partner")},</p>
            <p>Please update the onboarding package for <strong>${esc(input.carrierLegalName)}</strong>.</p>
            <p><strong>Reason:</strong> ${esc(input.reason)}</p>
            <p style="margin:24px 0">
              <a href="${esc(input.onboardingUrl)}" style="background:#059669;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;display:inline-block;font-weight:600">
                Open Secure Onboarding
              </a>
            </p>
          </div>`;
        await sendMail({ to: input.to, subject, text, html });
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
