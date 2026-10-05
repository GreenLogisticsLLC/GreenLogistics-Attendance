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

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    const qToken = typeof req.query.token === "string" ? req.query.token : "";
    const raw =
        (header?.startsWith("Bearer ") ? header.slice(7) : "") ||
        (req.method === "GET" ? qToken : "") ||
        "";
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
