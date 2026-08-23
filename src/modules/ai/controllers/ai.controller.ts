import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { apiResponse } from "../../../utils/helpers.js";
import { prisma } from "../../../config/database.js";
import { aiGateway } from "../services/ai-gateway.js";
import { aiOrchestrator } from "../services/ai-orchestrator.js";
import { aiTools } from "../services/ai-tools.js";
import { getOpenAiConfig } from "../../../config/env.js";
import { operationalAiService } from "../operational/operational.service.js";
import { aiActionService } from "../actions/action.service.js";
import { proposalsFromOperationalRecommendations } from "../actions/proposals.js";

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
            phase: "9",
            commandCenterEnabled:
                String(process.env.AI_COMMAND_CENTER_ENABLED ?? "true").toLowerCase() !== "false",
            shipmentLifecycleEnabled:
                String(process.env.AI_SHIPMENT_LIFECYCLE_ENABLED ?? "true").toLowerCase() !==
                "false",
            tools: [
                "getCarrierById",
                "getShipmentById",
                "listCarrierDocuments",
                "findCarriers",
                "searchGreenOS",
                "carrierOperationalSummary",
                "shipmentOperationalSummary",
                "carrierCommunicationContext",
                "shipmentCommunicationContext",
                "shipmentLifecycle",
                "commandCenter",
                "marketRateQuote",
                "aiActionPropose",
                "aiActionConfirm",
            ],
            searchMode: "STRUCTURED",
            knowledgeProvider: "StructuredKnowledgeSearchProvider",
            operational: true,
            marketRate: true,
            marketRateProvider: "InternalHistoricalRateProvider",
            marketRateProviders: {
                internal: "AVAILABLE",
                dat: "NOT_CONNECTED",
                truckstop: "NOT_CONNECTED",
            },
            actionsEnabled: true,
            communicationsEnabled: true,
            actionTypes: [
                "SEND_EMAIL",
                "CREATE_INTERNAL_NOTE",
                "CREATE_FOLLOW_UP",
                "REQUEST_DOCUMENT",
                "MARK_REVIEW_REQUIRED",
            ],
            blockedActionTypes: [
                "APPROVE_CARRIER",
                "REJECT_CARRIER",
                "CLOSE_SHIPMENT",
                "CHANGE_RATE",
                "DELETE_DOCUMENT",
                "PAY_CARRIER",
                "BOOK_LOAD",
                "NEGOTIATE_RATE",
            ],
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

export async function aiCarrierSummaryController(req: AuthRequest, res: Response) {
    try {
        const userId = req.user?.userId;
        const role = req.user?.role;
        const id = String(req.params.id || "").trim();
        if (!userId || !role) return res.status(401).json(apiResponse(false, "Unauthorized"));
        if (!id) return res.status(422).json(apiResponse(false, "carrier id required"));

        const started = Date.now();
        const data = await operationalAiService.carrierSummary({ userId, role }, id);

        const proposedActions = [];
        if (role !== "Viewer") {
            const drafts = proposalsFromOperationalRecommendations({
                carrierId: id,
                recommendations: (data.nextBestActions || []).map((a) => ({
                    id: a.id,
                    text: a.text,
                    reason: a.reason,
                    priority: a.priority,
                    source: a.source,
                })),
                carrierEmail:
                    typeof data.carrier?.email === "string" ? data.carrier.email : null,
            });
            for (const draft of drafts.slice(0, 3)) {
                try {
                    proposedActions.push(
                        await aiActionService.propose({ userId, role }, draft)
                    );
                } catch {
                    // Skip proposals that fail ACL/validation — summary still returns.
                }
            }
        }

        await prisma.aiRun
            .create({
                data: {
                    actorUserId: userId,
                    model: "operational",
                    requestPreview: `carrier-summary:${id}`.slice(0, 500),
                    intent: "carrier_summary",
                    answerMode: "operational",
                    toolsJson: JSON.stringify({
                        tools: ["carrierOperationalSummary", "aiActionPropose"],
                        readiness: data.readiness,
                        compliance: data.compliance.light,
                        proposedActionCount: proposedActions.length,
                        latencyMs: Date.now() - started,
                    }),
                    sourcesJson: JSON.stringify(data.sources),
                    status: "SUCCESS",
                    completedAt: new Date(),
                },
            })
            .catch((e) => console.warn("[ai] carrier summary audit failed", e));

        return res.json(
            apiResponse(true, "OK", {
                ...data,
                proposedActions,
                actionsRequireConfirmation: true,
            })
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : "Carrier summary failed";
        const status =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(status || 500).json(apiResponse(false, message));
    }
}

export async function aiShipmentSummaryController(req: AuthRequest, res: Response) {
    try {
        const userId = req.user?.userId;
        const role = req.user?.role;
        const id = String(req.params.id || "").trim();
        if (!userId || !role) return res.status(401).json(apiResponse(false, "Unauthorized"));
        if (!id) return res.status(422).json(apiResponse(false, "shipment id required"));

        const started = Date.now();
        const data = await operationalAiService.shipmentSummary({ userId, role }, id);

        const proposedActions = [];
        if (role !== "Viewer") {
            const drafts = proposalsFromOperationalRecommendations({
                shipmentLeadId: id,
                recommendations: (data.nextBestActions || []).map((a) => ({
                    id: a.id,
                    text: a.text,
                    reason: a.reason,
                    priority: a.priority,
                    source: a.source,
                })),
                carrierEmail: null,
            });
            for (const draft of drafts.slice(0, 3)) {
                try {
                    proposedActions.push(
                        await aiActionService.propose({ userId, role }, draft)
                    );
                } catch {
                    // Skip proposals that fail ACL/validation — summary still returns.
                }
            }
        }

        await prisma.aiRun
            .create({
                data: {
                    actorUserId: userId,
                    model: "operational",
                    requestPreview: `shipment-summary:${id}`.slice(0, 500),
                    intent: "shipment_summary",
                    answerMode: "operational",
                    toolsJson: JSON.stringify({
                        tools: ["shipmentOperationalSummary", "aiActionPropose"],
                        readiness: data.readiness,
                        proposedActionCount: proposedActions.length,
                        latencyMs: Date.now() - started,
                    }),
                    sourcesJson: JSON.stringify(data.sources),
                    status: "SUCCESS",
                    completedAt: new Date(),
                },
            })
            .catch((e) => console.warn("[ai] shipment summary audit failed", e));

        return res.json(
            apiResponse(true, "OK", {
                ...data,
                proposedActions,
                actionsRequireConfirmation: true,
            })
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : "Shipment summary failed";
        const status =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(status || 500).json(apiResponse(false, message));
    }
}
