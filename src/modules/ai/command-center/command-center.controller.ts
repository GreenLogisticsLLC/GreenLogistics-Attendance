import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { apiResponse } from "../../../utils/helpers.js";
import { prisma } from "../../../config/database.js";
import { aiActionService } from "../actions/action.service.js";
import { proposalsFromOperationalRecommendations } from "../actions/proposals.js";
import { commandCenterService } from "./service.js";
import type {
    AiOperationalCategory,
    AiOperationalItem,
    AiOperationalPriority,
    CommandCenterActor,
    CommandCenterQuery,
    CommandCenterResult,
} from "./types.js";

const PRIORITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]);
const CATEGORIES = new Set([
    "SHIPMENT",
    "CARRIER",
    "DOCUMENT",
    "COMMUNICATION",
    "MARKET",
    "COMPLIANCE",
    "FOLLOW_UP",
    "INTERNAL_REVIEW",
]);
const ACTIONABLE = new Set(["REQUEST_DOCUMENT", "FOLLOW_UP", "SEND_EMAIL"]);

function actorOf(req: AuthRequest): CommandCenterActor {
    const userId = req.user?.userId;
    const role = req.user?.role;
    if (!userId || !role) throw Object.assign(new Error("Unauthorized"), { status: 401 });
    return { userId, role };
}

function queryOf(req: AuthRequest): CommandCenterQuery {
    const priority = String(req.query.priority || "").toUpperCase();
    const category = String(req.query.category || "").toUpperCase();
    return {
        priority: PRIORITIES.has(priority) ? (priority as AiOperationalPriority) : undefined,
        category: CATEGORIES.has(category) ? (category as AiOperationalCategory) : undefined,
        entityType: req.query.entityType ? String(req.query.entityType) : undefined,
        entityId: req.query.entityId ? String(req.query.entityId) : undefined,
        limit: Math.min(100, Math.max(1, Number(req.query.limit) || 25)),
        offset: Math.max(0, Number(req.query.offset) || 0),
        myWork: String(req.query.myWork || "").toLowerCase() === "true",
    };
}

function recommendationFor(item: AiOperationalItem) {
    const prefix =
        item.nextBestAction === "REQUEST_DOCUMENT"
            ? "req-"
            : item.nextBestAction === "FOLLOW_UP" || item.nextBestAction === "SEND_EMAIL"
              ? "comm-followup-"
              : "review-";
    return {
        id: `${prefix}${item.dedupeKey}`,
        text:
            item.nextBestAction === "REQUEST_DOCUMENT"
                ? `Request ${item.title.split(" ")[0]}`
                : item.title,
        reason: item.reason,
        priority: item.priority,
        source: item.sources[0]?.id,
    };
}

export async function attachCommandCenterActions(
    actor: CommandCenterActor,
    result: CommandCenterResult,
    aiRunId?: string
): Promise<CommandCenterResult> {
    if (actor.role === "Viewer") return result;
    let proposed = 0;
    for (const item of result.items) {
        if (proposed >= 5 || !ACTIONABLE.has(item.nextBestAction)) continue;
        const drafts = proposalsFromOperationalRecommendations({
            carrierId: item.entityType === "carrier" ? item.entityId : undefined,
            shipmentLeadId: item.entityType === "shipment" ? item.entityId : undefined,
            recommendations: [recommendationFor(item)],
            carrierEmail: null,
            aiRunId,
        });
        const draft = drafts[0];
        if (!draft) continue;
        try {
            item.action = await aiActionService.propose(actor, draft);
            proposed += 1;
        } catch {
            item.action = null;
        }
    }
    return { ...result, actionsRequireConfirmation: true };
}

function sendError(res: Response, error: unknown, fallback: string) {
    const message = error instanceof Error ? error.message : fallback;
    const status =
        error && typeof error === "object" && "status" in error
            ? Number((error as { status: number }).status)
            : 500;
    return res.status(status || 500).json(apiResponse(false, message));
}

export async function commandCenterGetController(req: AuthRequest, res: Response) {
    try {
        const actor = actorOf(req);
        const result = await commandCenterService.getAttention(actor, queryOf(req));
        await attachCommandCenterActions(actor, result);
        return res.json(apiResponse(true, "OK", result));
    } catch (error) {
        return sendError(res, error, "Command Center failed");
    }
}

export async function commandCenterSummaryController(req: AuthRequest, res: Response) {
    try {
        const actor = actorOf(req);
        const started = Date.now();
        const run = await prisma.aiRun.create({
            data: {
                actorUserId: actor.userId,
                model: "deterministic-command-center",
                requestPreview: "command-center-summary",
                intent: "command_center",
                answerMode: "operational",
                status: "PENDING",
            },
        });
        const result = await commandCenterService.getAttention(actor, {
            ...queryOf(req),
            limit: 25,
            offset: 0,
        });
        await attachCommandCenterActions(actor, result, run.runId);
        const summary = commandCenterService.buildDailySummary(result);
        await prisma.aiRun
            .update({
                where: { runId: run.runId },
                data: {
                    toolsJson: JSON.stringify({
                        tools: ["commandCenter"],
                        itemCount: result.summaryHints?.total || 0,
                        latencyMs: Date.now() - started,
                    }),
                    sourcesJson: JSON.stringify(result.sources || []),
                    status: "SUCCESS",
                    completedAt: new Date(),
                },
            })
            .catch((error) => console.warn("[ai] command center audit failed", error));
        return res.json(
            apiResponse(true, "OK", {
                ...summary,
                actionsRequireConfirmation: true,
                marketProviders: result.marketProviders,
            })
        );
    } catch (error) {
        return sendError(res, error, "Command Center summary failed");
    }
}
