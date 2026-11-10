import { sendCorporateMail } from "../../services/email.service.js";

const INVOICE_SENDER_EMAIL = "accounting@greengrouplogistics.com";
const INVOICE_SENDER = `Green Logistics Accounting <${INVOICE_SENDER_EMAIL}>`;

function esc(s: string): string {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function greetingName(name?: string | null): string {
    const n = String(name || "").trim();
    return n || "valued customer";
}

export function buildCustomerInvoiceEmail(input: {
    customerName?: string | null;
    loadNumber?: string | null;
    invoiceNumber?: string | null;
    amountDue?: number | null;
}): { subject: string; text: string; html: string } {
    const name = greetingName(input.customerName);
    const loadLabel = input.loadNumber ? `Load ${input.loadNumber}` : "your shipment";
    const invoiceLabel = input.invoiceNumber || "your invoice";
    const amount =
        input.amountDue != null && Number.isFinite(Number(input.amountDue))
            ? `$${Number(input.amountDue).toLocaleString("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
              })}`
            : null;

    const subject = `Invoice for delivered shipment${
        input.loadNumber ? ` — ${input.loadNumber}` : ""
    }`;

    const text = [
        `Hello ${name},`,
        "",
        `We are happy to let you know that ${loadLabel} was successfully delivered.`,
        "",
        "Thank you for choosing Green Logistics. We appreciate your trust and the opportunity to handle this shipment for you.",
        "",
        `Please find ${invoiceLabel} attached. Kindly process payment according to the invoice${
            amount ? ` (amount due: ${amount})` : ""
        }.`,
        "",
        "If you have any questions about this invoice or need payment instructions, reply to this email or contact accounting@greengrouplogistics.com.",
        "",
        "Best regards,",
        "Green Logistics Accounting Team",
    ].join("\n");

    const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;color:#1d2a3a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f7fb;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #dbe4f0;">
          <tr>
            <td style="background:#16325c;color:#ffffff;padding:22px 28px;">
              <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.8;">Green Logistics</div>
              <div style="font-size:22px;font-weight:700;margin-top:4px;">Your shipment was delivered</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <p style="margin:0 0 16px;font-size:16px;">Hello ${esc(name)},</p>
              <p style="margin:0 0 14px;line-height:1.6;">
                We are happy to let you know that <strong>${esc(loadLabel)}</strong> was successfully delivered.
              </p>
              <p style="margin:0 0 14px;line-height:1.6;">
                Thank you for choosing Green Logistics. We appreciate your trust and the opportunity to handle this shipment for you.
              </p>
              <p style="margin:0 0 14px;line-height:1.6;">
                Please find <strong>${esc(invoiceLabel)}</strong> attached. Kindly process payment according to the invoice${
                    amount ? ` (amount due: <strong>${esc(amount)}</strong>)` : ""
                }.
              </p>
              <p style="margin:0 0 14px;line-height:1.6;">
                If you have any questions about this invoice or need payment instructions, reply to this email or contact
                <a href="mailto:accounting@greengrouplogistics.com">accounting@greengrouplogistics.com</a>.
              </p>
              <p style="margin:0;line-height:1.5;">
                Best regards,<br>
                <strong>Green Logistics Accounting Team</strong>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    return { subject, text, html };
}

export async function sendCustomerInvoiceEmail(input: {
    to: string;
    customerName?: string | null;
    loadNumber?: string | null;
    invoiceNumber?: string | null;
    amountDue?: number | null;
    attachment: {
        filename: string;
        content: Buffer;
        contentType?: string;
    };
}): Promise<{ from: string; via: "system" }> {
    const mail = buildCustomerInvoiceEmail(input);
    try {
        await sendCorporateMail({
            from: INVOICE_SENDER,
            to: input.to,
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
            attachments: [input.attachment],
        });
    } catch (err) {
        const systemError = err instanceof Error ? err.message : String(err);
        throw Object.assign(
            new Error(
                `Could not send the customer invoice email from ${INVOICE_SENDER_EMAIL}. ` +
                    `Check the corporate SMTP settings. Details: ${systemError}`
            ),
            { status: 400, code: "CUSTOMER_INVOICE_MAIL_UNAVAILABLE" }
        );
    }
    return { from: INVOICE_SENDER_EMAIL, via: "system" };
}
