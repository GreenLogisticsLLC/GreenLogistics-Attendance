import { Request, Response, NextFunction } from "express";
import { authService } from "../services/auth.service.js";
import { apiResponse } from "../utils/helpers.js";

export interface AuthRequest extends Request {
    user?: { userId: string; username: string; role: string };
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
        return res.status(401).json(apiResponse(false, "Unauthorized"));
    }

    const payload = authService.verifyToken(header.slice(7));
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
