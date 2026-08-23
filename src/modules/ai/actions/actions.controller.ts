import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { apiResponse } from "../../../utils/helpers.js";
import { aiActionService } from "./action.service.js";
import { isAllowedActionType, isBlockedActionType, type AiActionTargetType } from "./constants.js";
import type { ProposeAiActionInput } from "./types.js";

function actorOf(req: AuthRequest) {
    return { userId: req.user!.userId, role: req.user!.role };
}

function statusOf(err: unknown): number {
    if (err && typeof err === "object" && "status" in err) {
        return Number((err as { status: number }).status) || 500;
    }
    return 500;
}

function codeOf(err: unknown): string | undefined {
    if (err && typeof err === "object" && "code" in err) {
        return String((err as { code: string }).code);
    }
    return undefined;
}

export async function proposeAiActionController(req: AuthRequest, res: Response) {
    try {
        if (!req.user?.userId || !req.user?.role) {
            return res.status(401).json(apiResponse(false, "Unauthorized"));
        }
        if (req.user.role === "Viewer") {
            return res.status(403).json(apiResponse(false, "Viewers cannot propose AI actions"));
        }

        const body = req.body && typeof req.body === "object" ? req.body : {};
        const actionType = String(body.actionType || "");
        if (isBlockedActionType(actionType)) {
            return res
                .status(422)
                .json(apiResponse(false, `Action type ${actionType} is blocked in Phase 6`));
        }
        if (!isAllowedActionType(actionType)) {
            return res.status(422).json(apiResponse(false, "Invalid action type"));
        }

        const input: ProposeAiActionInput = {
            actionType,
            title: String(body.title || actionType),
            description: body.description ? String(body.description) : undefined,
            reason: body.reason ? String(body.reason) : undefined,
            targetType: String(body.targetType || "none") as AiActionTargetType,
            targetId: body.targetId ? String(body.targetId) : undefined,
            payload: body.payload && typeof body.payload === "object" ? body.payload : {},
            sources: Array.isArray(body.sources) ? body.sources : [],
            aiRunId: body.aiRunId ? String(body.aiRunId) : undefined,
            groundingHash: body.groundingHash ? String(body.groundingHash) : undefined,
        };

        const action = await aiActionService.propose(actorOf(req), input);
        return res
            .status(201)
            .json(apiResponse(true, "Action proposed — awaiting confirmation", action));
    } catch (err) {
        return res
            .status(statusOf(err))
            .json(
                apiResponse(false, err instanceof Error ? err.message : "Propose failed", {
                    code: codeOf(err),
                })
            );
    }
}

export async function getAiActionController(req: AuthRequest, res: Response) {
    try {
        if (!req.user?.userId || !req.user?.role) {
            return res.status(401).json(apiResponse(false, "Unauthorized"));
        }
        const action = await aiActionService.get(
            actorOf(req),
            String(req.params.actionId || "")
        );
        return res.json(apiResponse(true, "OK", action));
    } catch (err) {
        return res
            .status(statusOf(err))
            .json(
                apiResponse(false, err instanceof Error ? err.message : "Get failed", {
                    code: codeOf(err),
                })
            );
    }
}

export async function confirmAiActionController(req: AuthRequest, res: Response) {
    try {
        if (!req.user?.userId || !req.user?.role) {
            return res.status(401).json(apiResponse(false, "Unauthorized"));
        }
        if (req.user.role === "Viewer") {
            return res.status(403).json(apiResponse(false, "Viewers cannot confirm AI actions"));
        }
        // Body payload is intentionally ignored — stored proposal is the source of truth.
        const result = await aiActionService.confirm(
            actorOf(req),
            String(req.params.actionId || "")
        );
        return res.json(apiResponse(true, result.status, result));
    } catch (err) {
        return res
            .status(statusOf(err))
            .json(
                apiResponse(false, err instanceof Error ? err.message : "Confirm failed", {
                    code: codeOf(err),
                })
            );
    }
}

export async function cancelAiActionController(req: AuthRequest, res: Response) {
    try {
        if (!req.user?.userId || !req.user?.role) {
            return res.status(401).json(apiResponse(false, "Unauthorized"));
        }
        const action = await aiActionService.cancel(
            actorOf(req),
            String(req.params.actionId || "")
        );
        return res.json(apiResponse(true, "CANCELLED", action));
    } catch (err) {
        return res
            .status(statusOf(err))
            .json(
                apiResponse(false, err instanceof Error ? err.message : "Cancel failed", {
                    code: codeOf(err),
                })
            );
    }
}
