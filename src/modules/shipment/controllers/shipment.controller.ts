import type { Request, Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { assertShipmentAccess } from "../../../auth/access.js";
import { crmService } from "../../crm/services/crm.service.js";
import { domainEventEngine } from "../services/domain-event.engine.js";
import { shipmentService } from "../services/shipment.service.js";
import { ensureGreenOsShipmentId } from "../shipment.id.js";

function errStatus(err: unknown): number {
    return (err as { status?: number })?.status || 500;
}

export const shipmentController = {
    async getCard(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const access = await assertShipmentAccess(req, res, id);
            if (!access.ok) return;
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
            const access = await assertShipmentAccess(req, res, id);
            if (!access.ok) return;
            // Brokers never supply a Load Number — system allocates GL100001…
            if (req.body?.loadNumber || req.body?.load_number) {
                res.status(422).json({
                    success: false,
                    message: "Load Number is system-generated only — do not send loadNumber in the body",
                });
                return;
            }
            const { loadService } = await import("../services/load.service.js");
            await loadService.createLoad(id, req.user?.userId);
            const card = await crmService.getShipmentCard(id);
            res.json({
                success: true,
                message: "Load Number allocated automatically on existing Shipment Card",
                data: card,
            });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to apply load number",
            });
        }
    },

    async listEvents(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const access = await assertShipmentAccess(req, res, id);
            if (!access.ok) return;
            const events = await domainEventEngine.listForShipment(id);
            res.json({ success: true, data: events });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to list events",
            });
        }
    },

    async updateOperations(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const access = await assertShipmentAccess(req, res, id);
            if (!access.ok) return;
            await shipmentService.updateOperations(id, req.body || {}, req.user?.userId);
            const card = await crmService.getShipmentCard(id);
            res.json({
                success: true,
                message: "Operations saved on existing Shipment Card",
                data: card,
            });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to save operations",
            });
        }
    },
};
