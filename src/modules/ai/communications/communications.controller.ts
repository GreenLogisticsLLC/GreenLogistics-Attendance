import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { prisma } from "../../../config/database.js";
import { apiResponse } from "../../../utils/helpers.js";
import { aiActionService } from "../actions/action.service.js";
import { proposalsFromOperationalRecommendations } from "../actions/proposals.js";
import { communicationService } from "./context.service.js";

async function handle(
    req: AuthRequest,
    res: Response,
    entityType: "carrier" | "shipment"
) {
    try {
        const userId = req.user?.userId;
        const role = req.user?.role;
        const id = String(req.params.id || "").trim();
        if (!userId || !role) return res.status(401).json(apiResponse(false, "Unauthorized"));
        if (!id) return res.status(422).json(apiResponse(false, `${entityType} id required`));
        const started = Date.now();
        const actor = { userId, role };
        const context =
            entityType === "carrier"
                ? await communicationService.carrierCommunications(actor, id)
                : await communicationService.shipmentCommunications(actor, id);
        const proposedActions = [];
        if (role !== "Viewer") {
            let carrierEmail: string | null = null;
            if (entityType === "carrier") {
                carrierEmail =
                    (
                        await prisma.carrier.findUnique({
                            where: { carrierId: context.carrierId || id },
                            select: { email: true },
                        })
                    )?.email || null;
            } else {
                const shipmentContact = await prisma.shipmentLead.findUnique({
                    where: { shipmentLeadId: context.entityId },
                    select: {
                        carrierEmail: true,
                        carrierProfile: { select: { email: true } },
                    },
                });
                carrierEmail =
                    shipmentContact?.carrierEmail || shipmentContact?.carrierProfile?.email || null;
            }
            const drafts = proposalsFromOperationalRecommendations({
                carrierId: entityType === "carrier" ? context.carrierId || id : undefined,
                shipmentLeadId: entityType === "shipment" ? context.entityId : undefined,
                recommendations: context.recommendations,
                carrierEmail,
            });
            for (const draft of drafts.slice(0, 3)) {
                try {
                    proposedActions.push(await aiActionService.propose(actor, draft));
                } catch {
                    // Context remains useful when a proposal cannot pass Phase 6 validation/ACL.
                }
            }
        }
        await prisma.aiRun
            .create({
                data: {
                    actorUserId: userId,
                    model: "communication-intelligence",
                    requestPreview: `${entityType}-communications:${id}`.slice(0, 500),
                    intent: `${entityType}_communication`,
                    answerMode: "operational",
                    toolsJson: JSON.stringify({
                        tools: ["communicationContext", "aiActionPropose"],
                        waitingFor: context.waitingFor,
                        proposedActionCount: proposedActions.length,
                        latencyMs: Date.now() - started,
                    }),
                    sourcesJson: JSON.stringify(context.sources),
                    status: "SUCCESS",
                    completedAt: new Date(),
                },
            })
            .catch((error) => console.warn("[ai] communication audit failed", error));
        return res.json(
            apiResponse(true, "OK", {
                ...context,
                proposedActions,
                actionsRequireConfirmation: true,
            })
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : "Communication context failed";
        const status =
            error && typeof error === "object" && "status" in error
                ? Number((error as { status: number }).status)
                : 500;
        return res.status(status || 500).json(apiResponse(false, message));
    }
}

export function aiCarrierCommunicationsController(req: AuthRequest, res: Response) {
    return handle(req, res, "carrier");
}

export function aiShipmentCommunicationsController(req: AuthRequest, res: Response) {
    return handle(req, res, "shipment");
}
