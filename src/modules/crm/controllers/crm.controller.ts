import { Response } from "express";
import { apiResponse } from "../../../utils/helpers.js";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { crmService } from "../services/crm.service.js";
import { assertShipmentAccess, scopedBrokerId } from "../../../auth/access.js";
import { canManageBrokers, isDataScopedRole } from "../../../auth/roles.js";
import { prisma } from "../../../config/database.js";

export async function crmDashboardController(req: AuthRequest, res: Response) {
    if (isDataScopedRole(req.user?.role || "")) {
        const data = await crmService.getBrokerWorkspace(req.user!.userId);
        if (!data) return res.status(404).json(apiResponse(false, "Broker profile not found"));
        return res.json(
            apiResponse(true, "Broker personal dashboard", {
                version: "1.0",
                scope: "self",
                ...data,
            })
        );
    }
    const data = await crmService.getDashboard();
    return res.json(apiResponse(true, "CRM dashboard", data));
}

export async function crmListShipmentsController(req: AuthRequest, res: Response) {
    const requested =
        typeof req.query.brokerId === "string" ? req.query.brokerId : undefined;
    const brokerId = scopedBrokerId(req, requested);
    if (
        isDataScopedRole(req.user?.role || "") &&
        requested &&
        requested !== req.user!.userId
    ) {
        return res.status(403).json(apiResponse(false, "Forbidden — cannot list another broker's shipments"));
    }
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const data = await crmService.listShipments({ brokerId, status });
    return res.json(apiResponse(true, "Shipments loaded", data));
}

export async function crmGetShipmentController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    const access = await assertShipmentAccess(req, res, id);
    if (!access.ok) return;
    const card = await crmService.getShipmentCard(id);
    if (!card) return res.status(404).json(apiResponse(false, "Shipment not found"));
    return res.json(apiResponse(true, "OK", card));
}

export async function crmListBrokersController(req: AuthRequest, res: Response) {
    if (isDataScopedRole(req.user?.role || "")) {
        const self = await crmService.getBrokerWorkspace(req.user!.userId);
        if (!self) return res.json(apiResponse(true, "Self workload", []));
        return res.json(
            apiResponse(true, "Self workload", [
                {
                    brokerId: self.broker.brokerId,
                    name: self.broker.name,
                    ...self.stats,
                },
            ])
        );
    }
    if (!canManageBrokers(req.user?.role || "")) {
        return res.status(403).json(apiResponse(false, "Forbidden"));
    }
    const data = await crmService.getBrokerWorkload();
    return res.json(apiResponse(true, "Brokers loaded", data));
}

export async function crmBrokerWorkspaceController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    if (isDataScopedRole(req.user?.role || "") && id !== req.user!.userId) {
        return res.status(403).json(apiResponse(false, "Forbidden — cannot open another broker workspace"));
    }
    if (!canManageBrokers(req.user?.role || "") && !isDataScopedRole(req.user?.role || "")) {
        return res.status(403).json(apiResponse(false, "Forbidden"));
    }
    const data = await crmService.getBrokerWorkspace(id);
    if (!data) return res.status(404).json(apiResponse(false, "Broker not found"));
    return res.json(apiResponse(true, "OK", data));
}

export async function crmUpdateShipmentController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    const access = await assertShipmentAccess(req, res, id);
    if (!access.ok) return;

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
    const access = await assertShipmentAccess(req, res, id);
    if (!access.ok) return;
    try {
        const data = await crmService.acceptShipment(id, req.user.userId);
        return res.json(apiResponse(true, "Shipment accepted", data));
    } catch (err) {
        const message = err instanceof Error ? err.message : "Accept failed";
        return res.status(500).json(apiResponse(false, message));
    }
}

/** Unique customers from broker's own shipments. */
export async function crmMyCustomersController(req: AuthRequest, res: Response) {
    const brokerId = scopedBrokerId(req);
    if (!brokerId && isDataScopedRole(req.user?.role || "")) {
        return res.status(401).json(apiResponse(false, "Unauthorized"));
    }
    const where = brokerId ? { assignedBrokerId: brokerId } : {};
    const rows = await prisma.shipmentLead.findMany({
        where,
        select: {
            customerName: true,
            shipmentLeadId: true,
            shipmentTitle: true,
            status: true,
            updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 500,
    });

    const map = new Map<
        string,
        { customer: string; shipmentCount: number; lastShipmentId: string; lastStatus: string; lastUpdated: Date }
    >();
    for (const r of rows) {
        const name = (r.customerName || "Unknown").trim() || "Unknown";
        const prev = map.get(name);
        if (!prev) {
            map.set(name, {
                customer: name,
                shipmentCount: 1,
                lastShipmentId: r.shipmentLeadId,
                lastStatus: r.status,
                lastUpdated: r.updatedAt,
            });
        } else {
            prev.shipmentCount += 1;
        }
    }
    return res.json(apiResponse(true, "Customers", [...map.values()]));
}

export async function crmMyNotificationsController(req: AuthRequest, res: Response) {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json(apiResponse(false, "Unauthorized"));

    const logs = await prisma.assignmentLog.findMany({
        where: isDataScopedRole(req.user?.role || "")
            ? { assignedUserId: userId }
            : {},
        orderBy: { createdAt: "desc" },
        take: 100,
    });

    return res.json(
        apiResponse(
            true,
            "Notifications",
            logs.map((l) => ({
                id: l.logId,
                type: l.eventType,
                message: l.message,
                shipmentLeadId: l.shipmentLeadId,
                createdAt: l.createdAt,
            }))
        )
    );
}
