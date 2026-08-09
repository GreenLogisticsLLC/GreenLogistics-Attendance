import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { assertShipmentAccess } from "../../../auth/access.js";
import { config } from "../../../config/env.js";
import { trackingService } from "../services/tracking.service.js";
import { carrierViewUserMessage } from "../providers/carrier-view/errors.js";

function errStatus(err: unknown): number {
    return (err as { status?: number; httpStatus?: number })?.status ||
        (err as { httpStatus?: number })?.httpStatus ||
        500;
}

function verifyWebhookSecret(req: AuthRequest, res: Response): boolean {
    const expected = config.carrierView.webhookSecret;
    if (!expected) return true; // no Green OS-side secret configured
    const q = String(req.query.k || req.query.token || "");
    const header =
        String(req.headers["x-greenos-webhook-token"] || "").trim() ||
        (String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1] || "").trim();
    if (q === expected || header === expected) return true;
    res.status(401).json({ success: false, message: "Unauthorized webhook" });
    return false;
}

export const trackingController = {
    async getForLoad(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const access = await assertShipmentAccess(req, res, id);
            if (!access.ok) return;
            const data = await trackingService.buildTrackingPayload(id);
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: carrierViewUserMessage(err),
            });
        }
    },

    async start(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const access = await assertShipmentAccess(req, res, id);
            if (!access.ok) return;
            const row = await trackingService.startCarrierViewTracking({
                shipmentLeadId: id,
                actorUserId: req.user?.userId,
                driverPhone: req.body?.driverPhone ?? req.body?.driver_phone,
                forceRecreate: Boolean(req.body?.forceRecreate),
                startsActiveMinutes: req.body?.startsActiveMinutes,
                emails: Array.isArray(req.body?.emails) ? req.body.emails : undefined,
            });
            res.json({ success: true, data: row });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: carrierViewUserMessage(err),
            });
        }
    },

    async refresh(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const access = await assertShipmentAccess(req, res, id);
            if (!access.ok) return;
            const row = await trackingService.refreshFromProvider(id, req.user?.userId);
            res.json({ success: true, data: row });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: carrierViewUserMessage(err),
            });
        }
    },

    async disable(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const access = await assertShipmentAccess(req, res, id);
            if (!access.ok) return;
            const row = await trackingService.disableTracking(id, req.user?.userId);
            res.json({ success: true, data: row });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: carrierViewUserMessage(err),
            });
        }
    },

    async chat(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const access = await assertShipmentAccess(req, res, id);
            if (!access.ok) return;
            const message = String(req.body?.message || "").trim();
            if (!message) {
                return res.status(422).json({ success: false, message: "message is required" });
            }
            await trackingService.sendChat(id, message, req.user?.userId);
            res.json({ success: true });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: carrierViewUserMessage(err),
            });
        }
    },

    async sms(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const access = await assertShipmentAccess(req, res, id);
            if (!access.ok) return;
            const type = String(req.body?.type || "welcome") as
                | "welcome"
                | "assigned_load"
                | "one_time_ping_request"
                | "installation_guide"
                | "custom";
            await trackingService.sendSms(id, type, req.body?.message, req.user?.userId);
            res.json({ success: true });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: carrierViewUserMessage(err),
            });
        }
    },

    async positions(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const access = await assertShipmentAccess(req, res, id);
            if (!access.ok) return;
            const data = await trackingService.listPositions(id, Number(req.query.limit) || 100);
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: carrierViewUserMessage(err),
            });
        }
    },

    async adminStatus(req: AuthRequest, res: Response) {
        try {
            const data = await trackingService.adminConnectionStatus();
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: carrierViewUserMessage(err),
            });
        }
    },

    async registerWebhooks(req: AuthRequest, res: Response) {
        try {
            const data = await trackingService.registerWebhooks(req.user?.userId);
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: carrierViewUserMessage(err),
            });
        }
    },

    async reconcileNow(req: AuthRequest, res: Response) {
        try {
            const data = await trackingService.reconcileActive();
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: carrierViewUserMessage(err),
            });
        }
    },

    async webhookPosition(req: AuthRequest, res: Response) {
        if (!verifyWebhookSecret(req, res)) return;
        try {
            const data = await trackingService.handlePositionWebhook(req.body);
            res.status(200).json({ success: true, data });
        } catch (err) {
            console.error("[CARRIERVIEW_WEBHOOK] position handler error", carrierViewUserMessage(err));
            res.status(200).json({ success: true, accepted: true });
        }
    },

    async webhookLoadStatus(req: AuthRequest, res: Response) {
        if (!verifyWebhookSecret(req, res)) return;
        try {
            const data = await trackingService.handleLoadStatusWebhook(req.body);
            res.status(200).json({ success: true, data });
        } catch (err) {
            console.error("[CARRIERVIEW_WEBHOOK] load-status handler error", carrierViewUserMessage(err));
            res.status(200).json({ success: true, accepted: true });
        }
    },

    async webhookChat(req: AuthRequest, res: Response) {
        if (!verifyWebhookSecret(req, res)) return;
        try {
            const data = await trackingService.handleChatWebhook(req.body);
            res.status(200).json({ success: true, data });
        } catch (err) {
            console.error("[CARRIERVIEW_WEBHOOK] chat handler error", carrierViewUserMessage(err));
            res.status(200).json({ success: true, accepted: true });
        }
    },
};
