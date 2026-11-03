import { Request, Response, NextFunction } from "express";
import { authService } from "../services/auth.service.js";
import { apiResponse } from "../utils/helpers.js";
import {
    type AccountingPermission,
    type AccountingSubRole,
    canAccessAccountingWorkspace,
    hasAccountingPermission,
} from "../auth/accounting.js";

export interface AuthRequest extends Request {
    user?: {
        userId: string;
        username: string;
        role: string;
        accountingSubRole?: AccountingSubRole | null;
    };
}

export function readRequestToken(req: Request): string {
    const header = req.headers.authorization;
    const fromHeader = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (fromHeader) return fromHeader;
    const altHeader = req.headers["x-greenos-token"];
    const alt = Array.isArray(altHeader) ? altHeader[0] : altHeader;
    if (typeof alt === "string" && alt.trim()) return alt.trim();
    const body = req.body as { sessionToken?: unknown } | undefined;
    if (body && typeof body.sessionToken === "string" && body.sessionToken.trim()) {
        const token = body.sessionToken.trim();
        delete body.sessionToken;
        return token;
    }
    if (req.method === "GET" && typeof req.query.token === "string" && req.query.token.trim()) {
        return req.query.token.trim();
    }
    return "";
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
    const raw = readRequestToken(req);
    if (!raw) {
        return res.status(401).json(apiResponse(false, "Unauthorized"));
    }

    const payload = authService.verifyToken(raw);
    if (!payload) {
        return res.status(401).json(apiResponse(false, "Invalid or expired token"));
    }

    req.user = payload;
    next();
}

export function requireRole(...roles: string[]) {
    return (req: AuthRequest, res: Response, next: NextFunction) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json(apiResponse(false, "Insufficient permissions"));
        }
        next();
    };
}

/** Accounting workspace access (Accounting Team or Owner/Admin). */
export function requireAccountingAccess() {
    return (req: AuthRequest, res: Response, next: NextFunction) => {
        if (!req.user || !canAccessAccountingWorkspace(req.user.role)) {
            return res.status(403).json(apiResponse(false, "Accounting access required"));
        }
        next();
    };
}

/** Specific Accounting permission (Team + Sub-role + Permission). */
export function requireAccountingPermission(permission: AccountingPermission) {
    return (req: AuthRequest, res: Response, next: NextFunction) => {
        if (!req.user) {
            return res.status(401).json(apiResponse(false, "Unauthorized"));
        }
        if (
            !hasAccountingPermission(
                req.user.role,
                req.user.accountingSubRole,
                permission
            )
        ) {
            return res
                .status(403)
                .json(apiResponse(false, `Missing Accounting permission: ${permission}`));
        }
        next();
    };
}
