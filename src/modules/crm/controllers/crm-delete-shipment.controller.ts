import type { Response } from "express";
import { apiResponse } from "../../../utils/helpers.js";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { assertShipmentAccess } from "../../../auth/access.js";
import { loadService } from "../../shipment/services/load.service.js";

/** Owner / Manager / Admin hard-delete a shipment or load from the board. */
export async function crmDeleteShipmentController(req: AuthRequest, res: Response) {
    const role = req.user?.role || "";
    if (role !== "Owner" && role !== "Manager" && role !== "Administrator") {
        return res
            .status(403)
            .json(apiResponse(false, "Only Owner or Manager can delete a load"));
    }
    const id = String(req.params.id || "").trim();
    if (!id) {
        return res.status(400).json(apiResponse(false, "Shipment id required"));
    }
    const access = await assertShipmentAccess(req, res, id);
    if (!access.ok) return;

    try {
        const data = await loadService.deleteLoad(id);
        return res.json(apiResponse(true, "Load deleted", data));
    } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to delete load";
        const status =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(status || 500).json(apiResponse(false, message));
    }
}
