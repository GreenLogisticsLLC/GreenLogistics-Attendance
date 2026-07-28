import type { Request, Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { crmService } from "../../crm/services/crm.service.js";
import { domainEventEngine } from "../services/domain-event.engine.js";
import { shipmentService } from "../services/shipment.service.js";
import { ensureGreenOsShipmentId } from "../shipment.id.js";

function errStatus(err: unknown): number {
    return (err as { status?: number })?.status || 500;
}

export const shipmentController = {
    async getCard(req: Request, res: Response) {
        try {
            const id = String(req.params.id || "");
            await ensureGreenOsShipmentId(id).catch(() => null);
            const card = await crmService.getShipmentCard(id);
            if (!card) {
                res.status(404).json({ success: false, message: "Shipment not found" });
                return;
            }
            res.json({ success: true, data: card });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to load shipment",
            });
        }
    },

    async applyLoadNumber(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const loadNumber = String(req.body?.loadNumber || req.body?.load_number || "");
            await shipmentService.applyLoadNumber({
                shipmentLeadId: id,
                loadNumber,
                actorUserId: req.user?.userId,
            });
            const card = await crmService.getShipmentCard(id);
            res.json({
                success: true,
                message: "Load Number applied to existing Shipment Card (no new record)",
                data: card,
            });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to apply load number",
            });
        }
    },

    async listEvents(req: Request, res: Response) {
        try {
            const id = String(req.params.id || "");
            const events = await domainEventEngine.listForShipment(id);
            res.json({ success: true, data: events });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to list events",
            });
        }
    },
};
