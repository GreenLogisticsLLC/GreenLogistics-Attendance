import { prisma } from "../config/database.js";
import { apiResponse } from "../utils/helpers.js";
import type { AuthRequest } from "../middlewares/auth.middleware.js";
import { isDataScopedRole } from "./roles.js";
import type { Response } from "express";

export async function assertShipmentAccess(
    req: AuthRequest,
    res: Response,
    shipmentLeadId: string
): Promise<{ ok: true; assignedBrokerId: string | null } | { ok: false }> {
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId },
        select: { shipmentLeadId: true, assignedBrokerId: true },
    });
    if (!lead) {
        res.status(404).json(apiResponse(false, "Shipment not found"));
        return { ok: false };
    }

    const role = req.user?.role || "";
    const userId = req.user?.userId || "";

    if (isDataScopedRole(role)) {
        if (!lead.assignedBrokerId || lead.assignedBrokerId !== userId) {
            res.status(403).json(
                apiResponse(false, "Forbidden — this shipment is assigned to another broker")
            );
            return { ok: false };
        }
    }

    return { ok: true, assignedBrokerId: lead.assignedBrokerId };
}

export function scopedBrokerId(req: AuthRequest, requestedBrokerId?: string): string | undefined {
    if (isDataScopedRole(req.user?.role || "")) {
        return req.user!.userId;
    }
    return requestedBrokerId;
}
