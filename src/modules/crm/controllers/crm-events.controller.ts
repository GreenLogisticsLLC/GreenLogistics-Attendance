import { Request, Response } from "express";
import { authService } from "../../../services/auth.service.js";
import { apiResponse } from "../../../utils/helpers.js";
import {
    sseSubscribe,
    startSseHeartbeat,
    sseClientCount,
} from "../services/realtime.hub.js";

/**
 * GET /api/crm/events
 * Server-Sent Events stream. Auth via Bearer header or ?token= (EventSource cannot set headers).
 */
export async function crmEventsSseController(req: Request, res: Response) {
    const header = req.headers.authorization;
    const qToken = typeof req.query.token === "string" ? req.query.token : "";
    const raw =
        (header?.startsWith("Bearer ") ? header.slice(7) : "") || qToken || "";
    const payload = authService.verifyToken(raw);
    if (!payload) {
        return res.status(401).json(apiResponse(false, "Unauthorized"));
    }

    startSseHeartbeat();

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // nginx
    if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
    }

    res.write(
        `event: connected\ndata: ${JSON.stringify({
            ok: true,
            userId: payload.userId,
            clients: sseClientCount() + 1,
        })}\n\n`
    );

    sseSubscribe({
        userId: payload.userId,
        role: payload.role,
        res,
    });
}
