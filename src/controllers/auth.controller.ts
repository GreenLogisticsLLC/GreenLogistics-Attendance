import { Request, Response } from "express";
import { prisma } from "../config/database.js";
import { config } from "../config/env.js";
import { authService } from "../services/auth.service.js";
import { apiResponse } from "../utils/helpers.js";
import type { AuthRequest } from "../middlewares/auth.middleware.js";

function approvalPage(title: string, message: string, ok: boolean) {
    const color = ok ? "#10b981" : "#ef4444";
    const loginUrl = config.publicAppUrl || "/";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; background:#0f1419; color:#e8edf4; display:flex; min-height:100vh; align-items:center; justify-content:center; margin:0; }
    .card { max-width:480px; background:#1a2332; border:1px solid #2d3f56; border-radius:16px; padding:2rem; text-align:center; }
    h1 { color:${color}; font-size:1.4rem; margin:0 0 1rem; }
    p { color:#8b9cb3; line-height:1.5; margin:0 0 1.5rem; }
    a.login-btn {
      display:inline-block; background:#10b981; color:#fff; text-decoration:none;
      padding:0.85rem 1.4rem; border-radius:8px; font-weight:600;
    }
    a.login-btn:hover { background:#059669; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
    <a class="login-btn" href="${loginUrl}">Go to Login</a>
  </div>
</body>
</html>`;
}

export async function loginController(req: Request, res: Response) {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(422).json(apiResponse(false, "Username or email and password required"));
    }

    const result = await authService.login(username, password);
    if (!result.ok) {
        return res.status(result.status).json(apiResponse(false, result.message));
    }

    return res.json(apiResponse(true, "Login successful", result.data));
}

export async function registerController(req: Request, res: Response) {
    const { username, password, firstName, lastName, email, role } = req.body;
    const result = await authService.register({
        username: username || "",
        password: password || "",
        firstName: firstName || "",
        lastName: lastName || "",
        email,
        role: role || "",
    });

    if (!result.ok) {
        return res.status(result.status).json(apiResponse(false, result.message));
    }

    return res.status(201).json(apiResponse(true, result.data.message, result.data));
}

export async function approveRegistrationController(req: Request, res: Response) {
    const token = String(req.query.token || "");
    const result = await authService.decideRegistration(token, "APPROVED");
    if (!result.ok) {
        return res
            .status(result.status)
            .send(approvalPage("Approval failed", result.message, false));
    }
    return res.send(approvalPage("Registration approved", result.message, true));
}

export async function rejectRegistrationController(req: Request, res: Response) {
    const token = String(req.query.token || "");
    const result = await authService.decideRegistration(token, "REJECTED");
    if (!result.ok) {
        return res
            .status(result.status)
            .send(approvalPage("Rejection failed", result.message, false));
    }
    return res.send(approvalPage("Registration rejected", result.message, true));
}

export async function meController(req: AuthRequest, res: Response) {
    if (!req.user) {
        return res.status(401).json(apiResponse(false, "Unauthorized"));
    }
    const user = await prisma.user.findUnique({
        where: { userId: req.user.userId },
        include: { role: true },
    });
    if (!user) {
        return res.status(401).json(apiResponse(false, "User not found"));
    }
    return res.json(
        apiResponse(true, "OK", {
            userId: user.userId,
            username: user.username,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role.roleName,
        })
    );
}
