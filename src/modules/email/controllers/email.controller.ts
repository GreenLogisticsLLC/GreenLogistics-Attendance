import { Request, Response } from "express";
import { config } from "../../../config/env.js";
import { apiResponse } from "../../../utils/helpers.js";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { emailImportService } from "../services/email-import.service.js";
import { shipmentLeadService } from "../services/shipment-lead.service.js";
import { shipmentImportLogRepository } from "../services/repositories.js";
import { gmailListener } from "../gmail/gmail.listener.js";
import {
    getGmailRedirectUri,
    gmailOAuthService,
    parseCompanyOAuthState,
} from "../gmail/gmail-oauth.service.js";
import {
    brokerGmailOAuthService,
    parseBrokerOAuthState,
} from "../gmail/broker-gmail-oauth.service.js";
import { brokerGmailSyncService } from "../gmail/broker-gmail-sync.service.js";
import { prisma } from "../../../config/database.js";
import { authService } from "../../../services/auth.service.js";

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

function authenticatedUser(req: Request) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    return authService.verifyToken(header.slice(7));
}

function wantsJson(req: Request): boolean {
    return req.query.json === "1" || String(req.headers.accept || "").includes("application/json");
}

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

/**
 * GET /api/email/auth — public company Gmail OAuth start (302 → Google).
 * Optional ?brokerId= still requires JWT (prefer /api/email/broker/auth for brokers).
 */
export async function gmailAuthController(req: Request, res: Response) {
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

        const brokerId = typeof req.query.brokerId === "string" ? req.query.brokerId.trim() : "";
        let url: string;

        if (brokerId) {
            // Broker mailbox binding must stay authenticated.
            const actor = authenticatedUser(req);
            if (!actor) {
                return res.status(401).json(apiResponse(false, "Unauthorized"));
            }
            const user = await prisma.user.findUnique({
                where: { userId: actor.userId },
                include: { role: true },
            });
            if (
                !user ||
                !user.isActive ||
                user.role.roleName !== "Broker" ||
                user.employeeId !== brokerId
            ) {
                return res.status(403).json(
                    apiResponse(
                        false,
                        "A broker can connect Gmail only to their own employee profile"
                    )
                );
            }
            url = brokerGmailOAuthService.getAuthUrlForBroker(actor.userId, brokerId);
        } else {
            // Company inbox (effie) — public 302 into Google OAuth.
            url = gmailOAuthService.getAuthUrl("company");
        }

        if (wantsJson(req)) {
            return res.json(apiResponse(true, "OK", { url }));
        }
        return res.redirect(url);
    } catch (err) {
        const message = err instanceof Error ? err.message : "OAuth start failed";
        return res
            .status(500)
            .type("html")
            .send(htmlPage("Gmail OAuth", `<h1>Error</h1><p>${escapeHtml(message)}</p>`, false));
    }
}

/** GET /api/email/broker/auth — per-broker Gmail OAuth (JWT required). */
export async function brokerGmailAuthController(req: AuthRequest, res: Response) {
    try {
        if (!req.user?.userId) {
            return res.status(401).json(apiResponse(false, "Unauthorized"));
        }
        if (!brokerGmailOAuthService.isClientConfigured()) {
            return res.status(503).json(apiResponse(false, "Gmail OAuth client is not configured"));
        }
        const user = await prisma.user.findUnique({
            where: { userId: req.user.userId },
            include: { role: true },
        });
        if (!user?.employeeId || user.role.roleName !== "Broker") {
            return res.status(403).json(apiResponse(false, "Broker employee profile is required"));
        }
        const url = brokerGmailOAuthService.getAuthUrlForBroker(
            req.user.userId,
            user.employeeId
        );
        if (wantsJson(req)) {
            return res.json(apiResponse(true, "OK", { url }));
        }
        return res.redirect(url);
    } catch (err) {
        const message = err instanceof Error ? err.message : "Broker OAuth start failed";
        return res.status(500).json(apiResponse(false, message));
    }
}

/** GET /api/email/callback — Google redirects here with ?code=&state= */
export async function gmailCallbackController(req: Request, res: Response) {
    const error = typeof req.query.error === "string" ? req.query.error : "";
    if (error) {
        return res
            .status(400)
            .type("html")
            .send(htmlPage("Gmail OAuth", `<h1>Authorization denied</h1><p>${error}</p>`, false));
    }

    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const brokerState = parseBrokerOAuthState(state);
    const companyState = parseCompanyOAuthState(state);
    if (!brokerState && !companyState) {
        return res
            .status(400)
            .type("html")
            .send(htmlPage("Gmail OAuth", "<h1>Invalid or expired OAuth session</h1>", false));
    }

    try {
        if (brokerState) {
            const { email } = await brokerGmailOAuthService.exchangeCodeAndSaveForBroker(
                brokerState.userId,
                brokerState.brokerId,
                code
            );
            return res.status(200).type("html").send(
                htmlPage(
                    "Broker Gmail connected",
                    `<h1>Broker Gmail connected</h1>
                     <p>Mailbox: <strong>${escapeHtml(email)}</strong></p>
                     <p>GreenOS will monitor <em>uShip-related</em> emails only (personal mail is ignored).</p>
                     <p><a href="/">Back to GreenOS</a></p>`
                )
            );
        }

        const { email } = await gmailOAuthService.exchangeCodeAndSave(code);
        const approvalRetry = await authService.resendPendingApprovalEmails().catch((err) => {
            console.error(
                "[GMAIL OAUTH] Pending approval resend failed:",
                err instanceof Error ? err.message : err
            );
            return null;
        });
        return res.status(200).type("html").send(
            htmlPage(
                "Gmail connected",
                `<h1>Company Gmail connected</h1>
                 <p>${email ? `Mailbox: <strong>${escapeHtml(email)}</strong>` : ""}</p>
                 <p>Used for new uShip shipment import into GreenOS.</p>
                 ${
                     approvalRetry
                         ? `<p>Approval emails resent: <strong>${approvalRetry.sent}</strong>; failed: <strong>${approvalRetry.failed}</strong>.</p>`
                         : ""
                 }
                 <p><a href="/">Back to GreenOS</a></p>`
            )
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : "Token exchange failed";
        console.error("[GMAIL OAUTH] Callback failed:", message);
        return res
            .status(500)
            .type("html")
            .send(
                htmlPage(
                    "Gmail OAuth",
                    `<h1>Connection failed</h1><p>${escapeHtml(message)}</p>`,
                    false
                )
            );
    }
}

export async function brokerGmailStatusController(req: AuthRequest, res: Response) {
    if (!req.user?.userId) return res.status(401).json(apiResponse(false, "Unauthorized"));
    const account = await brokerGmailOAuthService.getAccount(req.user.userId);
    const user = await prisma.user.findUnique({
        where: { userId: req.user.userId },
        select: { employeeId: true },
    });
    return res.json(
        apiResponse(true, "OK", {
            connected: Boolean(
                account?.status === "CONNECTED" && account.isActive && account.refreshToken
            ),
            gmailAddress: account?.gmailAddress || null,
            status: account?.status || "DISCONNECTED",
            lastSyncAt: account?.lastSyncAt || null,
            lastError: account?.lastError || null,
            authUrl: user?.employeeId
                ? `/api/email/auth?brokerId=${encodeURIComponent(user.employeeId)}`
                : null,
            oauthClientConfigured: brokerGmailOAuthService.isClientConfigured(),
        })
    );
}

export async function brokerGmailDisconnectController(req: AuthRequest, res: Response) {
    if (!req.user?.userId) return res.status(401).json(apiResponse(false, "Unauthorized"));
    await brokerGmailOAuthService.disconnect(req.user.userId);
    return res.json(apiResponse(true, "Broker Gmail disconnected"));
}

export async function brokerGmailSyncController(req: AuthRequest, res: Response) {
    if (!req.user?.userId) return res.status(401).json(apiResponse(false, "Unauthorized"));
    const account = await brokerGmailOAuthService.getAccount(req.user.userId);
    if (!account?.isActive || !account.refreshToken) {
        return res.status(400).json(apiResponse(false, "Connect your Gmail first"));
    }
    try {
        const result = await brokerGmailSyncService.syncOneAccount(account);
        return res.json(apiResponse(true, "Broker mailbox synced", result));
    } catch (err) {
        const message = err instanceof Error ? err.message : "Sync failed";
        return res.status(500).json(apiResponse(false, message));
    }
}

export async function brokerGmailMessagesController(req: AuthRequest, res: Response) {
    if (!req.user?.userId) return res.status(401).json(apiResponse(false, "Unauthorized"));
    const rows = await brokerGmailSyncService.listMessagesForBroker(req.user.userId, 100);
    return res.json(apiResponse(true, "OK", rows));
}

export async function listBrokerGmailAccountsController(_req: AuthRequest, res: Response) {
    const brokers = await prisma.user.findMany({
        where: { role: { roleName: "Broker" } },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
        include: {
            employee: {
                select: {
                    employeeId: true,
                    employeeNumber: true,
                    firstName: true,
                    lastName: true,
                },
            },
            brokerGmailAccount: {
                select: {
                    gmailAddress: true,
                    isActive: true,
                    status: true,
                    lastSyncAt: true,
                    lastError: true,
                    connectedAt: true,
                },
            },
        },
    });
    return res.json(
        apiResponse(
            true,
            "OK",
            brokers.map((broker) => ({
                userId: broker.userId,
                employeeId: broker.employeeId,
                employeeNumber: broker.employee?.employeeNumber || null,
                username: broker.username,
                name:
                    `${broker.employee?.firstName || broker.firstName} ${
                        broker.employee?.lastName || broker.lastName
                    }`.trim(),
                gmailAddress: broker.brokerGmailAccount?.gmailAddress || null,
                isActive: broker.brokerGmailAccount?.isActive || false,
                status: broker.brokerGmailAccount?.status || "DISCONNECTED",
                lastSyncAt: broker.brokerGmailAccount?.lastSyncAt || null,
                lastError: broker.brokerGmailAccount?.lastError || null,
                connectedAt: broker.brokerGmailAccount?.connectedAt || null,
            }))
        )
    );
}

export async function adminDisconnectBrokerGmailController(req: AuthRequest, res: Response) {
    const userId = String(req.params.userId || "").trim();
    const broker = await prisma.user.findUnique({
        where: { userId },
        include: { role: true },
    });
    if (!broker || broker.role.roleName !== "Broker") {
        return res.status(404).json(apiResponse(false, "Broker not found"));
    }

    const disconnected = await brokerGmailOAuthService.disconnect(userId);
    if (!disconnected) {
        return res.status(404).json(apiResponse(false, "Broker Gmail account not found"));
    }
    return res.json(apiResponse(true, "Broker Gmail disconnected"));
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
        const broker = await brokerGmailSyncService.syncAllBrokers().catch(() => null);
        const ok = result.configured;
        return res.status(ok ? 200 : 503).json(
            apiResponse(ok, result.message, { ...result, brokerGmail: broker })
        );
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
    const gmailUser = gmailConfigured ? await gmailOAuthService.getStoredUser() : config.gmail.user || "";
    const smtpConfigured = Boolean(config.smtp.host && config.smtp.user && config.smtp.pass);
    const brokerAccounts = await prisma.brokerGmailAccount.count({
        where: { status: "CONNECTED", isActive: true, NOT: { refreshToken: "" } },
    });
    return res.json(
        apiResponse(true, "OK", {
            gmailConfigured,
            gmailUser,
            oauthClientConfigured: gmailOAuthService.isClientConfigured(),
            redirectUri: getGmailRedirectUri(),
            authUrl: "/api/email/auth",
            brokerAuthUrl: "/api/email/broker/auth",
            brokerAccountsConnected: brokerAccounts,
            pollIntervalSeconds: Math.round(config.emailPollIntervalMs / 1000),
            approvalEmail: config.approvalEmail,
            smtpConfigured,
            smtpUser: config.smtp.user || "",
            smtpFrom: config.smtp.from || "",
            mailRolesSeparated: !(
                gmailUser &&
                config.smtp.user &&
                gmailUser.trim().toLowerCase() === config.smtp.user.trim().toLowerCase()
            ),
        })
    );
}
