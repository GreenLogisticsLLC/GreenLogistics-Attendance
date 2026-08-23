import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { apiResponse } from "../../../utils/helpers.js";
import { prisma } from "../../../config/database.js";
import { aiActionService } from "../actions/action.service.js";
import { proposalsFromOperationalRecommendations } from "../actions/proposals.js";
import { shipmentLifecycleService } from "./service.js";

export function lifecycleRecommendations(
    data: Awaited<ReturnType<typeof shipmentLifecycleService.build>>
) {
    const recommendations = [...(data.communication?.recommendations || [])];
    if (data.nextBestAction === "REQUEST_DOCUMENT") {
        const documentType = data.missingItems.includes("POD")
            ? "POD"
            : data.missingItems[0] || "required document";
        recommendations.unshift({
            id: `req-${documentType.toLowerCase()}`,
            text: `Request ${documentType}`,
            reason: `${documentType} is required for shipment progress`,
            priority: "HIGH",
            source: data.shipmentId,
        });
    }
    if (
        data.nextBestAction === "FOLLOW_UP_CARRIER" ||
        data.nextBestAction === "FOLLOW_UP_CUSTOMER"
    ) {
        recommendations.unshift({
            id: `comm-followup-${data.nextBestAction.toLowerCase()}`,
            text:
                data.nextBestAction === "FOLLOW_UP_CUSTOMER"
                    ? "Follow up with customer"
                    : "Follow up with carrier",
            reason: data.communication?.followUp.reason || "A response is still outstanding",
            priority: "MEDIUM",
            source: data.shipmentId,
        });
    }
    return recommendations;
}

export async function aiShipmentLifecycleController(req: AuthRequest, res: Response) {
    try {
        const userId = req.user?.userId;
        const role = req.user?.role;
        const id = String(req.params.id || "").trim();
        if (!userId || !role) return res.status(401).json(apiResponse(false, "Unauthorized"));
        if (!id) return res.status(422).json(apiResponse(false, "shipment id required"));
        const started = Date.now();
        const data = await shipmentLifecycleService.build({ userId, role }, id);
        const run = await prisma.aiRun.create({
            data: {
                actorUserId: userId,
                model: "deterministic-lifecycle",
                requestPreview: `shipment-lifecycle:${id}`.slice(0, 500),
                intent: "shipment_lifecycle",
                answerMode: "operational",
                toolsJson: JSON.stringify({
                    tools: ["shipmentLifecycle"],
                    stage: data.currentStage,
                    health: data.lifecycleHealth,
                    latencyMs: Date.now() - started,
                }),
                sourcesJson: JSON.stringify(data.sources),
                status: "SUCCESS",
                completedAt: new Date(),
            },
        });

        const proposedActions = [];
        if (role !== "Viewer") {
            const drafts = proposalsFromOperationalRecommendations({
                shipmentLeadId: data.shipmentId,
                recommendations: lifecycleRecommendations(data),
                carrierEmail:
                    data.nextBestAction === "FOLLOW_UP_CUSTOMER"
                        ? typeof data.customer?.email === "string"
                            ? data.customer.email
                            : null
                        : typeof data.carrier?.email === "string"
                          ? data.carrier.email
                          : null,
                aiRunId: run.runId,
            }).filter((draft) =>
                ["REQUEST_DOCUMENT", "SEND_EMAIL"].includes(draft.actionType)
            );
            for (const draft of drafts.slice(0, 3)) {
                try {
                    proposedActions.push(await aiActionService.propose({ userId, role }, draft));
                } catch {
                    // Lifecycle context remains available when a proposal fails validation or ACL.
                }
            }
        }
        return res.json(
            apiResponse(true, "OK", {
                ...data,
                proposedActions,
                actionsRequireConfirmation: true,
            })
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : "Shipment lifecycle failed";
        const status =
            error && typeof error === "object" && "status" in error
                ? Number((error as { status: number }).status)
                : 500;
        return res.status(status || 500).json(apiResponse(false, message));
    }
}

export const _lifecycleControllerTestUtils = { lifecycleRecommendations };
