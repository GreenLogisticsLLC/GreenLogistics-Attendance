import { Request, Response } from "express";
import { apiResponse } from "../../../utils/helpers.js";
import { emailImportService } from "../services/email-import.service.js";
import { shipmentLeadService } from "../services/shipment-lead.service.js";
import { shipmentImportLogRepository } from "../services/repositories.js";
import { gmailListener } from "../gmail/gmail.listener.js";

export async function listShipmentsController(_req: Request, res: Response) {
    const shipments = await shipmentLeadService.list(200);
    return res.json(apiResponse(true, "Shipments loaded", shipments));
}

export async function getShipmentController(req: Request, res: Response) {
    const id = String(req.params.id);
    const shipment = await shipmentLeadService.getById(id);
    if (!shipment) {
        return res.status(404).json(apiResponse(false, "Shipment not found"));
    }
    return res.json(apiResponse(true, "OK", shipment));
}

export async function checkEmailController(_req: Request, res: Response) {
    try {
        const result = await emailImportService.checkInbox();
        const ok = result.configured;
        return res.status(ok ? 200 : 503).json(apiResponse(ok, result.message, result));
    } catch (err) {
        const message = err instanceof Error ? err.message : "Email check failed";
        return res.status(500).json(apiResponse(false, message));
    }
}

export async function listEmailLogsController(_req: Request, res: Response) {
    const logs = await shipmentImportLogRepository.list(300);
    return res.json(apiResponse(true, "Logs loaded", logs));
}

export async function emailStatusController(_req: Request, res: Response) {
    return res.json(
        apiResponse(true, "OK", {
            gmailConfigured: gmailListener.isConfigured(),
            pollIntervalSeconds: 30,
        })
    );
}
