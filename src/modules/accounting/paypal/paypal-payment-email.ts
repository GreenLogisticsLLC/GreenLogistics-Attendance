import { sendCorporateMail } from "../../../services/email.service.js";

const SENDER_EMAIL = "accounting@greengrouplogistics.com";
const SENDER = `Green Logistics Accounting <${SENDER_EMAIL}>`;

function esc(s: string): string {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function money(n: number): string {
    return `$${Number(n).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}`;
}

export function buildPayPalPaymentEmail(input: {
    customerName?: string | null;
    loadNumber?: string | null;
    invoiceNumber?: string | null;
    amountUsd: number;
    approvalUrl: string;
}): { subject: string; text: string; html: string } {
    const name = String(input.customerName || "").trim() || "valued customer";
    const loadLabel = input.loadNumber ? `Load ${input.loadNumber}` : "your shipment";
    const invoiceLabel = input.invoiceNumber || "your invoice";
    const amount = money(input.amountUsd);
    const subject = `PayPal payment link for ${input.loadNumber || "your Green Logistics shipment"}`;

    const text = [
        `Hello ${name},`,
        "",
        `Please pay ${amount} for ${loadLabel} (${invoiceLabel}) using the secure PayPal Checkout link below:`,
        "",
        input.approvalUrl,
        "",
        "This link opens PayPal Checkout for Green Logistics LLC.",
        "If you have questions, reply to this email or contact accounting@greengrouplogistics.com.",
        "",
        "Best regards,",
        "Green Logistics Accounting Team",
    ].join("\n");

    const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;color:#1d2a3a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f7fb;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #dbe4f0;">
        <tr><td style="background:#16325c;color:#ffffff;padding:22px 28px;">
          <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.8;">Green Logistics</div>
          <div style="font-size:22px;font-weight:700;margin-top:4px;">PayPal payment request</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 16px;font-size:16px;">Hello ${esc(name)},</p>
          <p style="margin:0 0 14px;line-height:1.6;">
            Please pay <strong>${esc(amount)}</strong> for <strong>${esc(loadLabel)}</strong>
            (${esc(invoiceLabel)}) using the secure PayPal Checkout button below.
          </p>
          <p style="margin:24px 0;text-align:center;">
            <a href="${esc(input.approvalUrl)}" style="display:inline-block;background:#0070ba;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;">
              Pay with PayPal
            </a>
          </p>
          <p style="margin:0 0 14px;line-height:1.6;font-size:13px;color:#52657a;word-break:break-all;">
            Or open this link: ${esc(input.approvalUrl)}
          </p>
          <p style="margin:0;line-height:1.5;">
            Best regards,<br><strong>Green Logistics Accounting Team</strong>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

    return { subject, text, html };
}

export async function sendPayPalPaymentEmail(input: {
    to: string;
    customerName?: string | null;
    loadNumber?: string | null;
    invoiceNumber?: string | null;
    amountUsd: number;
    approvalUrl: string;
}): Promise<{ from: string }> {
    const mail = buildPayPalPaymentEmail(input);
    try {
        await sendCorporateMail({
            from: SENDER,
            to: input.to,
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
        });
    } catch (err) {
        const systemError = err instanceof Error ? err.message : String(err);
        throw Object.assign(
            new Error(
                `Could not send the PayPal payment email from ${SENDER_EMAIL}. Details: ${systemError}`
            ),
            { status: 400, code: "PAYPAL_MAIL_UNAVAILABLE" }
        );
    }
    return { from: SENDER_EMAIL };
}
