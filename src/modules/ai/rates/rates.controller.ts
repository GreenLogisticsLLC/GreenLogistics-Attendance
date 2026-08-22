import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { apiResponse } from "../../../utils/helpers.js";
import { marketRateService } from "../rates/market-rate.service.js";

export async function marketRateQuoteController(req: AuthRequest, res: Response) {
    try {
        const userId = req.user?.userId;
        const role = req.user?.role;
        if (!userId || !role) {
            return res.status(401).json(apiResponse(false, "Unauthorized"));
        }

        const body = req.body && typeof req.body === "object" ? req.body : {};
        const data = await marketRateService.quote(
            { userId, role },
            {
                shipmentId: body.shipmentId ? String(body.shipmentId) : undefined,
                origin: body.origin ? String(body.origin) : undefined,
                destination: body.destination ? String(body.destination) : undefined,
                originZip: body.originZip ? String(body.originZip) : undefined,
                destinationZip: body.destinationZip ? String(body.destinationZip) : undefined,
                originCity: body.originCity ? String(body.originCity) : undefined,
                originState: body.originState ? String(body.originState) : undefined,
                destinationCity: body.destinationCity ? String(body.destinationCity) : undefined,
                destinationState: body.destinationState ? String(body.destinationState) : undefined,
                equipment: body.equipment ? String(body.equipment) : undefined,
                miles: body.miles != null ? Number(body.miles) : undefined,
                weight: body.weight ? String(body.weight) : undefined,
                pickupDate: body.pickupDate ? String(body.pickupDate) : undefined,
                currentCarrierQuote:
                    body.currentCarrierQuote != null
                        ? Number(body.currentCarrierQuote)
                        : undefined,
            }
        );

        return res.json(apiResponse(true, "OK", data));
    } catch (err) {
        const message = err instanceof Error ? err.message : "Market rate quote failed";
        const status =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(status || 500).json(apiResponse(false, message));
    }
}
