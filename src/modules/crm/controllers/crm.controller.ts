import { Response } from "express";
import { apiResponse } from "../../../utils/helpers.js";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { crmService } from "../services/crm.service.js";

export async function crmDashboardController(_req: AuthRequest, res: Response) {
    const data = await crmService.getDashboard();
    return res.json(apiResponse(true, "CRM dashboard", data));
}

export async function crmListShipmentsController(req: AuthRequest, res: Response) {
    const brokerId = typeof req.query.brokerId === "string" ? req.query.brokerId : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const data = await crmService.listShipments({ brokerId, status });
    return res.json(apiResponse(true, "Shipments loaded", data));
}

export async function crmGetShipmentController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    const card = await crmService.getShipmentCard(id);
    if (!card) return res.status(404).json(apiResponse(false, "Shipment not found"));
    return res.json(apiResponse(true, "OK", card));
}

export async function crmListBrokersController(_req: AuthRequest, res: Response) {
    const data = await crmService.getBrokerWorkload();
    return res.json(apiResponse(true, "Brokers loaded", data));
}

export async function crmBrokerWorkspaceController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    const data = await crmService.getBrokerWorkspace(id);
    if (!data) return res.status(404).json(apiResponse(false, "Broker not found"));
    return res.json(apiResponse(true, "OK", data));
}

export async function crmUpdateShipmentController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    const { status, notes, price, priority } = req.body || {};
    if (!status) return res.status(422).json(apiResponse(false, "status is required"));
    try {
        const data = await crmService.updateShipmentStatus(id, String(status), req.user?.userId, {
            notes,
            price: price != null ? Number(price) : undefined,
            priority,
        });
        return res.json(apiResponse(true, "Shipment updated", data));
    } catch (err) {
        const message = err instanceof Error ? err.message : "Update failed";
        return res.status(500).json(apiResponse(false, message));
    }
}

export async function crmAcceptShipmentController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    if (!req.user?.userId) return res.status(401).json(apiResponse(false, "Unauthorized"));
    try {
        const data = await crmService.acceptShipment(id, req.user.userId);
        return res.json(apiResponse(true, "Shipment accepted", data));
    } catch (err) {
        const message = err instanceof Error ? err.message : "Accept failed";
        return res.status(500).json(apiResponse(false, message));
    }
}
