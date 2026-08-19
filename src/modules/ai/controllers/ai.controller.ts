import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { apiResponse } from "../../../utils/helpers.js";
import { aiAssistantService } from "../services/ai-assistant.service.js";
import { config } from "../../../config/env.js";

export async function aiStatusController(_req: AuthRequest, res: Response) {
    return res.json(
        apiResponse(true, "OK", {
            configured: aiAssistantService.isConfigured(),
            model: config.openai.model,
            projectConfigured: Boolean(config.openai.projectId),
            organizationConfigured: Boolean(config.openai.organizationId),
        })
    );
}

export async function aiChatController(req: AuthRequest, res: Response) {
    try {
        const message = String(req.body?.message || "");
        const history = Array.isArray(req.body?.history) ? req.body.history : [];
        const data = await aiAssistantService.chat({ message, history });
        return res.json(apiResponse(true, "OK", data));
    } catch (err) {
        const message = err instanceof Error ? err.message : "AI chat failed";
        const status =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(status || 500).json(apiResponse(false, message));
    }
}
