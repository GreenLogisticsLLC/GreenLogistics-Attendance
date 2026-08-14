import { sendCorporateMail } from "../../../services/email.service.js";

const REVIEW_SENDER_EMAIL = "accounting@greengrouplogistics.com";
const REVIEW_SENDER = `Green Logistics Accounting <${REVIEW_SENDER_EMAIL}>`;

export const REVIEW_LINKS = [
    {
        label: "Google",
        icon: "⭐",
        url: "https://g.page/r/CYnYasDBg-hSEAE/review",
    },
    {
        label: "LinkedIn",
        icon: "💼",
        url: "https://www.linkedin.com/company/greengrouplogisticsllc",
    },
    {
        label: "Website",
        icon: "🌐",
        url: "https://greengrouplogistics.com",
    },
    {
        label: "uShip",
        icon: "🚚",
        url: "https://www.uship.com/service-providers/789862666-green-logistics-llc",
    },
] as const;

function esc(s: string): string {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function greetingName(name?: string | null, fallback = "valued partner"): string {
    const n = String(name || "").trim();
    return n || fallback;
}

export function buildReviewEmail(input: {
    recipientKind: "customer" | "carrier";
    recipientName?: string | null;
    loadNumber?: string | null;
}): { subject: string; text: string; html: string } {
    const who = input.recipientKind === "customer" ? "customer" : "carrier partner";
    const name = greetingName(
        input.recipientName,
        input.recipientKind === "customer" ? "valued customer" : "valued carrier partner"
    );
    const loadLine = input.loadNumber ? `Load ${input.loadNumber}` : "your recent shipment";
    const subject = `Thank you for working with Green Logistics${input.loadNumber ? ` — ${input.loadNumber}` : ""}`;

    const text = [
        `Hello ${name},`,
        "",
        "Thank you for choosing Green Logistics and for giving us the opportunity to work with you. We truly appreciate your trust, cooperation, and the opportunity to be part of your transportation process.",
        "",
        "At Green Logistics, we always strive to provide reliable service, clear communication, and a smooth experience for both our customers and carrier partners. Your business and feedback mean a lot to us.",
        "",
        `This note is for ${loadLine}. If you were happy with our service, we would greatly appreciate it if you could take a moment to share your experience with us online. Your review helps our team grow and also helps other customers and transportation partners feel confident choosing Green Logistics.`,
        "",
        "You can find us here:",
        "",
        ...REVIEW_LINKS.map((l) => `${l.icon} ${l.label}: ${l.url}`),
        "",
        "Thank you again for working with Green Logistics. We truly value our relationship with you and look forward to working together again in the future!",
        "",
        "Best regards,",
        "Green Logistics Team",
    ].join("\n");

    const linkRows = REVIEW_LINKS.map(
        (l) =>
            `<tr>
              <td style="padding:8px 0;">
                <a href="${esc(l.url)}" style="display:inline-block;background:#16325c;color:#ffffff;text-decoration:none;border-radius:8px;padding:10px 14px;font-weight:600;">
                  ${l.icon} Leave a ${esc(l.label)} review
                </a>
              </td>
            </tr>`
    ).join("");

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
              <div style="font-size:22px;font-weight:700;margin-top:4px;">Thank you for working with us</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <p style="margin:0 0 16px;font-size:16px;">Hello ${esc(name)},</p>
              <p style="margin:0 0 14px;line-height:1.6;">
                Thank you for choosing Green Logistics and for giving us the opportunity to work with you.
                We truly appreciate your trust, cooperation, and the opportunity to be part of your transportation process.
              </p>
              <p style="margin:0 0 14px;line-height:1.6;">
                At Green Logistics, we always strive to provide reliable service, clear communication,
                and a smooth experience for both our customers and carrier partners. Your business and feedback mean a lot to us.
              </p>
              <p style="margin:0 0 14px;line-height:1.6;">
                This note is for <strong>${esc(loadLine)}</strong>. If you were happy with our service, we would greatly
                appreciate it if you could take a moment to share your experience with us online. Your review helps our team
                grow and also helps other ${esc(who)}s feel confident choosing Green Logistics.
              </p>
              <p style="margin:18px 0 8px;font-weight:700;">You can find us here:</p>
              <table role="presentation" cellspacing="0" cellpadding="0">${linkRows}</table>
              <p style="margin:22px 0 14px;line-height:1.6;">
                Thank you again for working with Green Logistics. We truly value our relationship with you
                and look forward to working together again in the future!
              </p>
              <p style="margin:0;line-height:1.5;">
                Best regards,<br>
                <strong>Green Logistics Team</strong>
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

/** Send every review request from the Green Logistics accounting mailbox. */
export async function sendLoadReviewEmail(input: {
    to: string;
    recipientKind: "customer" | "carrier";
    recipientName?: string | null;
    loadNumber?: string | null;
}): Promise<{ from: string; via: "system" }> {
    const mail = buildReviewEmail(input);
    try {
        await sendCorporateMail({
            from: REVIEW_SENDER,
            to: input.to,
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
        });
    } catch (err) {
        const systemError = err instanceof Error ? err.message : String(err);
        throw Object.assign(
            new Error(
                `Could not send the review email from ${REVIEW_SENDER_EMAIL}. ` +
                    `Check the corporate SMTP settings. Details: ${systemError}`
            ),
            { status: 400, code: "REVIEW_MAIL_UNAVAILABLE" }
        );
    }
    return {
        from: REVIEW_SENDER_EMAIL,
        via: "system",
    };
}
