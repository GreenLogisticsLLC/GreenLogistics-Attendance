import { Request, Response, NextFunction } from "express";
import { authService } from "../services/auth.service.js";
import { apiResponse } from "../utils/helpers.js";

export interface AuthRequest extends Request {
    user?: { userId: string; username: string; role: string };
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
