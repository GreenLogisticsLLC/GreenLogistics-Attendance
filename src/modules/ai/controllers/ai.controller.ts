import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { apiResponse } from "../../../utils/helpers.js";
import { prisma } from "../../../config/database.js";
import { aiGateway } from "../services/ai-gateway.js";
import { aiOrchestrator } from "../services/ai-orchestrator.js";
import { aiTools } from "../services/ai-tools.js";
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
            phase: 3,
            tools: [
                "getCarrierById",
                "getShipmentById",
                "listCarrierDocuments",
                "findCarriers",
                "searchGreenOS",
            ],
            searchMode: "STRUCTURED",
            knowledgeProvider: "StructuredKnowledgeSearchProvider",
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

export async function aiSearchController(req: AuthRequest, res: Response) {
    try {
        const query = String(req.body?.query || "").trim();
        const filters =
            req.body?.filters && typeof req.body.filters === "object" ? req.body.filters : {};
        const userId = req.user?.userId;
        const role = req.user?.role;
        if (!userId || !role) {
            return res.status(401).json(apiResponse(false, "Unauthorized"));
        }
        if (!query) {
            return res.status(422).json(apiResponse(false, "query is required"));
        }

        const started = Date.now();
        const toolResult = await aiTools.searchGreenOS({ userId, role }, query, filters);
        const latencyMs = Date.now() - started;

        // Audit search without storing email/document bodies
        await prisma.aiRun
            .create({
                data: {
                    actorUserId: userId,
                    model: "search-only",
                    requestPreview: query.slice(0, 500),
                    intent: String(filters.intentHint || "search"),
                    answerMode: toolResult.ok ? "grounded" : "not_found",
                    toolsJson: JSON.stringify({
                        tools: ["searchGreenOS"],
                        searchMode: "STRUCTURED",
                        resultCount: toolResult.ok
                            ? (toolResult.data as { resultCount?: number })?.resultCount || 0
                            : 0,
                        latencyMs,
                    }),
                    sourcesJson: JSON.stringify(toolResult.sources || []),
                    status: "SUCCESS",
                    completedAt: new Date(),
                },
            })
            .catch((e) => console.warn("[ai] search audit failed", e));

        if (!toolResult.ok) {
            return res.json(
                apiResponse(true, "OK", {
                    results: [],
                    sources: [],
                    searchMode: "STRUCTURED",
                    resultCount: 0,
                })
            );
        }

        const data = toolResult.data as {
            results: unknown[];
            sources?: unknown[];
            searchMode: string;
            resultCount: number;
        };
        return res.json(
            apiResponse(true, "OK", {
                results: data.results || [],
                sources: toolResult.sources || [],
                searchMode: data.searchMode || "STRUCTURED",
                resultCount: data.resultCount || 0,
            })
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : "AI search failed";
        const status =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(status || 500).json(apiResponse(false, message));
    }
}
