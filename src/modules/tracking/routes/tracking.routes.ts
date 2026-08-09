import { Router } from "express";
import { authMiddleware, requireRole } from "../../../middlewares/auth.middleware.js";
import { trackingController } from "../controllers/tracking.controller.js";

export const trackingRouter = Router();

/** CarrierView → Green OS webhooks (no JWT; optional ?k= webhook secret). */
trackingRouter.post("/webhooks/position", trackingController.webhookPosition);
trackingRouter.post("/webhooks/load-status", trackingController.webhookLoadStatus);
trackingRouter.post("/webhooks/chat", trackingController.webhookChat);

trackingRouter.get(
    "/admin/status",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager"),
    trackingController.adminStatus
);
trackingRouter.post(
    "/admin/register-webhooks",
    authMiddleware,
    requireRole("Administrator", "Owner"),
    trackingController.registerWebhooks
);
trackingRouter.post(
    "/admin/reconcile",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager"),
    trackingController.reconcileNow
);

export const loadTrackingRouter = Router({ mergeParams: true });

loadTrackingRouter.get("/", authMiddleware, trackingController.getForLoad);
loadTrackingRouter.post("/start", authMiddleware, trackingController.start);
loadTrackingRouter.post("/refresh", authMiddleware, trackingController.refresh);
loadTrackingRouter.post("/disable", authMiddleware, trackingController.disable);
loadTrackingRouter.post("/chat", authMiddleware, trackingController.chat);
loadTrackingRouter.post("/sms", authMiddleware, trackingController.sms);
loadTrackingRouter.get("/positions", authMiddleware, trackingController.positions);
