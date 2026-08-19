import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { customerService } from "../services/customer.service.js";

function errStatus(err: unknown): number {
    return (err as { status?: number })?.status || 500;
}

function actorFrom(req: AuthRequest) {
    return { userId: req.user?.userId || "", role: req.user?.role || "" };
}

export const customerController = {
    async list(req: AuthRequest, res: Response) {
        try {
            const data = await customerService.list(actorFrom(req), req.query.q ? String(req.query.q) : undefined);
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to list customers",
            });
        }
    },

    async get(req: AuthRequest, res: Response) {
        try {
            const data = await customerService.get(String(req.params.id), actorFrom(req));
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed",
            });
        }
    },

    async create(req: AuthRequest, res: Response) {
        try {
            const data = await customerService.create(req.body || {}, actorFrom(req));
            res.status(201).json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to add customer",
            });
        }
    },

    async update(req: AuthRequest, res: Response) {
        try {
            const data = await customerService.update(String(req.params.id), req.body || {}, actorFrom(req));
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to save customer",
            });
        }
    },

    async createLoad(req: AuthRequest, res: Response) {
        try {
            const data = await customerService.createLoad(
                String(req.params.id),
                req.body || {},
                actorFrom(req)
            );
            res.status(201).json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to create load",
            });
        }
    },
};
