import { Request, Response } from "express";
import { apiResponse } from "../../../utils/helpers.js";
import { emailImportService } from "../services/email-import.service.js";
import { shipmentLeadService } from "../services/shipment-lead.service.js";
import { shipmentImportLogRepository } from "../services/repositories.js";
import { gmailListener } from "../gmail/gmail.listener.js";
import { getGmailRedirectUri, gmailOAuthService } from "../gmail/gmail-oauth.service.js";

function htmlPage(title: string, bodyHtml: string, ok = true) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${title}</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#0f1a14;color:#e8f0ea;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
    .card{max-width:28rem;padding:2rem;border:1px solid #2a4a38;border-radius:12px;background:#15261c;text-align:center}
    h1{font-size:1.25rem;margin:0 0 .75rem;color:${ok ? "#86efac" : "#fca5a5"}}
    p{margin:0;opacity:.9;line-height:1.5}
    a{color:#86efac}
  </style>
</head>
<body><div class="card">${bodyHtml}</div></body>
</html>`;
}

/** GET /api/email/auth — redirect to Google OAuth consent. */
export async function gmailAuthController(_req: Request, res: Response) {
    try {
        if (!gmailOAuthService.isClientConfigured()) {
            return res
                .status(503)
                .type("html")
                .send(
                    htmlPage(
                        "Gmail OAuth",
                        "<h1>Gmail OAuth not configured</h1><p>Set <code>GMAIL_CLIENT_ID</code> and <code>GMAIL_CLIENT_SECRET</code> in the server environment.</p>",
                        false
                    )
                );
        }
        const url = gmailOAuthService.getAuthUrl();
        return res.redirect(url);
    } catch (err) {
        const message = err instanceof Error ? err.message : "OAuth start failed";
        return res.status(500).type("html").send(htmlPage("Gmail OAuth", `<h1>Error</h1><p>${message}</p>`, false));
    }
}

/** GET /api/email/callback — Google redirects here with ?code=… */
export async function gmailCallbackController(req: Request, res: Response) {
    const error = typeof req.query.error === "string" ? req.query.error : "";
    if (error) {
        return res
            .status(400)
            .type("html")
            .send(
                htmlPage(
                    "Gmail OAuth",
                    `<h1>Authorization denied</h1><p>${error}</p>`,
                    false
                )
            );
    }

    const code = typeof req.query.code === "string" ? req.query.code : "";
    try {
        const { email } = await gmailOAuthService.exchangeCodeAndSave(code);
        return res
            .status(200)
            .type("html")
            .send(
                htmlPage(
                    "Gmail connected",
                    `<h1>Gmail connected successfully</h1>
                     <p>${email ? `Mailbox: <strong>${email}</strong>` : ""}</p>
                     <p>GreenOS will use the saved refresh token to read new emails automatically.</p>
                     <p><a href="/">Back to GreenOS</a></p>`
                )
            );
    } catch (err) {
        const message = err instanceof Error ? err.message : "Token exchange failed";
        console.error("[GMAIL OAUTH] Callback failed:", message);
        return res
            .status(500)
            .type("html")
            .send(htmlPage("Gmail OAuth", `<h1>Connection failed</h1><p>${message}</p>`, false));
    }
}

export async function listShipmentsController(_req: Request, res: Response) {
    const shipments = await shipmentLeadService.list(200);
    return res.json(apiResponse(true, "Shipments loaded", shipments));
}

export async function getShipmentController(req: Request, res: Response) {
    const id = String(req.params.id);
    const shipment = await shipmentLeadService.getById(id);
    if (!shipment) {
        return res.status(404).json(apiResponse(false, "Shipment not found"));
    }
    return res.json(apiResponse(true, "OK", shipment));
}

export async function checkEmailController(_req: Request, res: Response) {
    try {
        const result = await emailImportService.checkInbox();
        const ok = result.configured;
        return res.status(ok ? 200 : 503).json(apiResponse(ok, result.message, result));
    } catch (err) {
        const message = err instanceof Error ? err.message : "Email check failed";
        return res.status(500).json(apiResponse(false, message));
    }
}

export async function listEmailLogsController(_req: Request, res: Response) {
    const logs = await shipmentImportLogRepository.list(300);
    return res.json(apiResponse(true, "Logs loaded", logs));
}

export async function emailStatusController(_req: Request, res: Response) {
    const gmailConfigured = await gmailListener.ensureCredentials();
    return res.json(
        apiResponse(true, "OK", {
            gmailConfigured,
            gmailUser: gmailConfigured ? await gmailOAuthService.getStoredUser() : "",
            oauthClientConfigured: gmailOAuthService.isClientConfigured(),
            redirectUri: getGmailRedirectUri(),
            authUrl: "/api/email/auth",
            pollIntervalSeconds: 30,
        })
    );
}
