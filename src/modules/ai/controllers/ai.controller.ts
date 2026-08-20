import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { apiResponse } from "../../../utils/helpers.js";
import { aiGateway } from "../services/ai-gateway.js";
import { aiOrchestrator } from "../services/ai-orchestrator.js";
import { getOpenAiConfig } from "../../../config/env.js";

export async function aiStatusController(_req: AuthRequest, res: Response) {
    const openai = getOpenAiConfig();
    const key = openai.apiKey;
    return res.json(
        apiResponse(true, "OK", {
            configured: aiGateway.isConfigured(),
            enabled: aiGateway.isEnabled(),
            model: openai.model,
            keySuffix: key ? key.slice(-4) : "",
            keyType: key.startsWith("sk-proj-")
                ? "project"
                : key.startsWith("sk-admin-")
                  ? "admin"
                  : key
                    ? "legacy"
                    : "none",
            projectConfigured: Boolean(openai.projectId),
            organizationConfigured: Boolean(openai.organizationId),
            phase: 1,
            tools: ["getCarrierById", "getShipmentById", "listCarrierDocuments", "findCarriers"],
        })
    );
}

export async function aiChatController(req: AuthRequest, res: Response) {
    try {
        const message = String(req.body?.message || "");
        const history = Array.isArray(req.body?.history) ? req.body.history : [];
        const userId = req.user?.userId;
        const role = req.user?.role;
        if (!userId || !role) {
            return res.status(401).json(apiResponse(false, "Unauthorized"));
        }

        const data = await aiOrchestrator.chat({
            actor: { userId, role },
            message,
            history,
        });
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
