import { Request, Response } from "express";
import { webhookService } from "../services/webhook.service.js";
import { apiResponse } from "../utils/helpers.js";
import { logWebhookReceived } from "../utils/webhook-logger.js";
import type { LegacyWebhookPayload, StandardWebhookPayload } from "../types/attendance.types.js";

export async function legacyWebhookController(req: Request, res: Response) {
    logWebhookReceived({
        path: req.path,
        headers: req.headers,
        body: req.body,
    });

    if (!webhookService.validateBearerToken(req.headers.authorization)) {
        console.log("[WEBHOOK] Unauthorized — missing/invalid Bearer token");
        return res.status(401).json({ code: "WEBHOOK_UNAUTHORIZED" });
    }

    const payload = req.body as LegacyWebhookPayload;
    if (!payload.device_id || !payload.token || !payload.decision || !payload.scanned_at) {
        console.log("[WEBHOOK] Validation failed — missing required fields");
        return res.status(422).json(apiResponse(false, "Missing required fields"));
    }

    try {
        const result = await webhookService.processLegacyPayload(
            payload,
            JSON.stringify(payload)
        );
        return res.status(result.status).json(
            apiResponse(true, result.duplicate ? "Duplicate ignored" : "Processed", {
                webhookId: result.webhookId,
                duplicate: result.duplicate,
            })
        );
    } catch (err) {
        console.error("[WEBHOOK] Processing error:", err);
        return res.status(500).json(apiResponse(false, "Internal processing error"));
    }
}

export async function standardWebhookController(req: Request, res: Response) {
    logWebhookReceived({
        path: req.path,
        headers: req.headers,
        body: req.body,
    });

    if (!webhookService.validateBearerToken(req.headers.authorization)) {
        console.log("[WEBHOOK] Unauthorized — missing/invalid Bearer token");
        return res.status(401).json(apiResponse(false, "Unauthorized"));
    }

    const payload = req.body as StandardWebhookPayload;
    if (
        !payload.employeeIdentifier ||
        !payload.timestamp ||
        !payload.direction ||
        !payload.deviceId ||
        !payload.webhookId
    ) {
        console.log("[WEBHOOK] Validation failed — missing required fields");
        return res.status(422).json(apiResponse(false, "Missing required fields"));
    }

    try {
        const result = await webhookService.processStandardPayload(
            payload,
            JSON.stringify(payload)
        );
        return res.status(result.status).json(
            apiResponse(true, result.duplicate ? "Duplicate ignored" : "Processed", {
                webhookId: result.webhookId,
                duplicate: result.duplicate,
            })
        );
    } catch (err) {
        console.error("[WEBHOOK] Processing error:", err);
        return res.status(500).json(apiResponse(false, "Internal processing error"));
    }
}

export async function testWebhookController(req: Request, res: Response) {
    const sample: LegacyWebhookPayload = {
        profile_id: "186",
        device_id: req.body.device_id || "12",
        token: req.body.token || "0aab3c5d",
        external_ref: req.body.external_ref,
        decision: req.body.decision || "enter",
        direction: req.body.direction || "in",
        scanned_at: req.body.scanned_at || new Date().toISOString(),
    };

    req.headers.authorization = `Bearer ${process.env.WEBHOOK_SECRET || "webhook-dev-secret"}`;
    req.body = sample;
    return legacyWebhookController(req, res);
}
