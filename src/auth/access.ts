import { prisma } from "../config/database.js";
import { apiResponse } from "../utils/helpers.js";
import type { AuthRequest } from "../middlewares/auth.middleware.js";
import { isDataScopedRole, isTeamScopedRole, Roles } from "./roles.js";
import { isBrokerOnTeam, listTeamBrokerIds } from "./team-scope.js";
import type { Response } from "express";

export async function assertShipmentAccess(
    req: AuthRequest,
    res: Response,
    shipmentLeadId: string
): Promise<{ ok: true; assignedBrokerId: string | null } | { ok: false }> {
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId },
        select: { shipmentLeadId: true, assignedBrokerId: true, status: true },
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
    } else if (isTeamScopedRole(role)) {
        const unassigned =
            !lead.assignedBrokerId ||
            lead.status === "NEW" ||
            lead.status === "UNASSIGNED";
        if (!unassigned && lead.assignedBrokerId) {
            const onTeam = await isBrokerOnTeam(userId, lead.assignedBrokerId);
            if (!onTeam) {
                res.status(403).json(
                    apiResponse(false, "Forbidden — this shipment is outside your team")
                );
                return { ok: false };
            }
        }
    }

    return { ok: true, assignedBrokerId: lead.assignedBrokerId };
}

/**
 * Same ACL as assertShipmentAccess, but throws { status } for service/tool callers
 * (no Express Response).
 */
export async function assertShipmentAccessOrThrow(
    actor: { userId: string; role: string },
    shipmentLeadId: string
): Promise<{ assignedBrokerId: string | null }> {
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId },
        select: { shipmentLeadId: true, assignedBrokerId: true, status: true },
    });
    if (!lead) {
        throw Object.assign(new Error("Shipment not found"), { status: 404, code: "NOT_FOUND" });
    }

    const role = actor.role || "";
    const userId = actor.userId || "";

    if (isDataScopedRole(role)) {
        if (!lead.assignedBrokerId || lead.assignedBrokerId !== userId) {
            throw Object.assign(new Error("Access denied"), { status: 403, code: "FORBIDDEN" });
        }
    } else if (isTeamScopedRole(role)) {
        const unassigned =
            !lead.assignedBrokerId ||
            lead.status === "NEW" ||
            lead.status === "UNASSIGNED";
        if (!unassigned && lead.assignedBrokerId) {
            const onTeam = await isBrokerOnTeam(userId, lead.assignedBrokerId);
            if (!onTeam) {
                throw Object.assign(new Error("Access denied"), { status: 403, code: "FORBIDDEN" });
            }
        }
    }

    return { assignedBrokerId: lead.assignedBrokerId };
}

/**
 * Resolve broker filter for list APIs.
 * - Broker → always self
 * - Team Lead → optional brokerId only if on their team; otherwise undefined (caller uses team ids)
 * - Others → optional requested brokerId
 */
export function scopedBrokerId(req: AuthRequest, requestedBrokerId?: string): string | undefined {
    if (isDataScopedRole(req.user?.role || "")) {
        return req.user!.userId;
    }
    return requestedBrokerId;
}

/** Team Lead userId when role is Team Lead; otherwise null. */
export function teamScopeUserId(req: AuthRequest): string | null {
    if (isTeamScopedRole(req.user?.role || "")) {
        return req.user?.userId || null;
    }
    return null;
}

export async function assertBrokerWorkspaceAccess(
    req: AuthRequest,
    res: Response,
    brokerId: string
): Promise<boolean> {
    const role = req.user?.role || "";
    const userId = req.user?.userId || "";

    if (isDataScopedRole(role)) {
        if (brokerId !== userId) {
            res.status(403).json(apiResponse(false, "Forbidden — cannot open another broker workspace"));
            return false;
        }
        return true;
    }

    if (isTeamScopedRole(role)) {
        const onTeam = await isBrokerOnTeam(userId, brokerId);
        if (!onTeam) {
            res.status(403).json(apiResponse(false, "Forbidden — broker is not on your team"));
            return false;
        }
        return true;
    }

    if (role === Roles.Administrator || role === Roles.Owner || role === Roles.Manager) {
        return true;
    }

    res.status(403).json(apiResponse(false, "Forbidden"));
    return false;
}

export { listTeamBrokerIds };
