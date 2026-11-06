/** Welcome email with Load Number — sent from the broker's connected Gmail. */

function esc(s: string): string {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export function buildCustomerLoadNumberEmail(input: {
    loadNumber: string;
}): { subject: string; text: string; html: string } {
    const loadNumber = String(input.loadNumber || "").trim() || "—";
    const subject = `Your Green Logistics Load Number — ${loadNumber}`;

    const text = [
        "Dear Valued Customer,",
        "",
        "Thank you for choosing Green Logistics LLC for your transportation needs!",
        "",
        "We truly appreciate your trust in our company and look forward to working with you. Our team will be happy to assist you throughout the entire shipping process, and we are committed to making your experience as smooth, convenient, and pleasant as possible.",
        "",
        "Your shipment has been successfully registered in our system, and the following Load Number has been generated:",
        "",
        `Load Number: #${loadNumber}`,
        "",
        "Please keep this number for your reference in any future communication regarding this shipment.",
        "",
        "For any questions, updates, or assistance related to your shipment, please feel free to contact the broker assigned to your load. Your dedicated broker will be your primary point of contact and will be happy to assist you.",
        "",
        "Thank you once again for choosing Green Logistics. We look forward to doing business with you!",
        "",
        "Best regards,",
        "Green Logistics LLC",
        "Your Trusted Transportation Partner",
    ].join("\n");

    const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;color:#1d2a3a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f7fb;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #dbe4f0;">
          <tr>
            <td style="background:#0b3d2e;color:#ffffff;padding:22px 28px;">
              <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">Green Logistics LLC</div>
              <div style="font-size:22px;font-weight:700;margin-top:4px;">Your shipment is registered</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;line-height:1.6;font-size:15px;">
              <p style="margin:0 0 16px;">Dear Valued Customer,</p>
              <p style="margin:0 0 14px;">Thank you for choosing Green Logistics LLC for your transportation needs!</p>
              <p style="margin:0 0 14px;">
                We truly appreciate your trust in our company and look forward to working with you.
                Our team will be happy to assist you throughout the entire shipping process, and we are
                committed to making your experience as smooth, convenient, and pleasant as possible.
              </p>
              <p style="margin:0 0 14px;">
                Your shipment has been successfully registered in our system, and the following Load Number
                has been generated:
              </p>
              <p style="margin:18px 0;padding:14px 18px;background:#eef7f2;border-radius:10px;font-size:18px;font-weight:700;color:#0b3d2e;">
                Load Number: #${esc(loadNumber)}
              </p>
              <p style="margin:0 0 14px;">
                Please keep this number for your reference in any future communication regarding this shipment.
              </p>
              <p style="margin:0 0 14px;">
                For any questions, updates, or assistance related to your shipment, please feel free to contact
                the broker assigned to your load. Your dedicated broker will be your primary point of contact
                and will be happy to assist you.
              </p>
              <p style="margin:0 0 14px;">
                Thank you once again for choosing Green Logistics. We look forward to doing business with you!
              </p>
              <p style="margin:24px 0 0;">
                Best regards,<br/>
                <strong>Green Logistics LLC</strong><br/>
                <span style="color:#5a6b7b;">Your Trusted Transportation Partner</span>
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
