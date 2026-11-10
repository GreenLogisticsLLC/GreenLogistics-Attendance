import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const CUSTOMER_AGREEMENT_TYPES = {
    USHIP_ONETIME: "USHIP_ONETIME",
    LONG_TIME: "LONG_TIME",
} as const;

export type CustomerAgreementType =
    (typeof CUSTOMER_AGREEMENT_TYPES)[keyof typeof CUSTOMER_AGREEMENT_TYPES];

const AGREEMENT_FILES: Record<
    CustomerAgreementType,
    { label: string; filename: string }
> = {
    USHIP_ONETIME: {
        label: "Broker Customer Uship OneTime",
        filename: "Broker Customer Uship OneTime.docx",
    },
    LONG_TIME: {
        label: "Broker Customer Long TIme",
        filename: "Broker Customer Long TIme.docx",
    },
};

export function normalizeCustomerAgreementType(
    value: unknown
): CustomerAgreementType | null {
    const raw = String(value || "")
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, "_");
    if (
        raw === "USHIP_ONETIME" ||
        raw === "BROKER_CUSTOMER_USHIP_ONETIME" ||
        raw === "ONETIME" ||
        raw === "ONE_TIME"
    ) {
        return CUSTOMER_AGREEMENT_TYPES.USHIP_ONETIME;
    }
    if (
        raw === "LONG_TIME" ||
        raw === "BROKER_CUSTOMER_LONG_TIME" ||
        raw === "LONGTIME" ||
        raw === "LONG"
    ) {
        return CUSTOMER_AGREEMENT_TYPES.LONG_TIME;
    }
    return null;
}

export function customerAgreementLabel(type: CustomerAgreementType): string {
    return AGREEMENT_FILES[type].label;
}

export function customerAgreementFilename(type: CustomerAgreementType): string {
    return AGREEMENT_FILES[type].filename;
}

function agreementsDir(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "../../../assets/customer-agreements");
}

export function readCustomerAgreementFile(type: CustomerAgreementType): {
    filename: string;
    content: Buffer;
    contentType: string;
} {
    const filename = customerAgreementFilename(type);
    const fullPath = path.join(agreementsDir(), filename);
    if (!fs.existsSync(fullPath)) {
        throw Object.assign(new Error(`Agreement file missing: ${filename}`), {
            status: 500,
            code: "CUSTOMER_AGREEMENT_FILE_MISSING",
        });
    }
    return {
        filename,
        content: fs.readFileSync(fullPath),
        contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
}

export function buildCustomerAgreementEmail(input: {
    companyName?: string | null;
    agreementType: CustomerAgreementType;
    signUrl: string;
    brokerName: string;
    sentDateLabel: string;
}): { subject: string; text: string; html: string } {
    const label = customerAgreementLabel(input.agreementType);
    const company = String(input.companyName || "").trim() || "Customer";
    const subject = `Green Logistics — ${label} (fill & sign online)`;
    const text = [
        `Dear ${company},`,
        "",
        "Thank you for choosing Green Logistics LLC.",
        "",
        `Please open this secure link to fill in your agreement fields and sign electronically:`,
        input.signUrl,
        "",
        `Agreement: ${label}`,
        `Green Logistics broker: ${input.brokerName} (Title: Broker)`,
        `Document date: ${input.sentDateLabel}`,
        "",
        "A PDF copy is attached. The Broker section is already completed. Use the link to complete Customer fields and your signature.",
        "",
        "Best regards,",
        "Green Logistics LLC",
    ].join("\n");
    const html = `<!DOCTYPE html>
<html><body style="font-family:Arial,Helvetica,sans-serif;color:#1d2a3a;line-height:1.55">
  <p>Dear ${escapeHtml(company)},</p>
  <p>Thank you for choosing <strong>Green Logistics LLC</strong>.</p>
  <p>Please open this secure link to <strong>fill every Customer field</strong> and <strong>sign</strong> electronically:</p>
  <p style="margin:18px 0"><a href="${escapeHtml(input.signUrl)}" style="display:inline-block;background:#0b3d2e;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700">Open agreement &amp; sign</a></p>
  <p style="font-size:13px;color:#475569">${escapeHtml(input.signUrl)}</p>
  <p><strong>Agreement:</strong> ${escapeHtml(label)}<br/>
  <strong>Broker:</strong> ${escapeHtml(input.brokerName)} — Title: Broker<br/>
  <strong>Document date:</strong> ${escapeHtml(input.sentDateLabel)}</p>
  <p>A PDF copy is attached. The Green Logistics / Broker block is already completed with the sending broker’s name, title, signature, and today’s date.</p>
  <p>Best regards,<br/>Green Logistics LLC</p>
</body></html>`;
    return { subject, text, html };
}

function escapeHtml(s: string): string {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
