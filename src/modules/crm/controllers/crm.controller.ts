import { Response } from "express";
import { apiResponse } from "../../../utils/helpers.js";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { crmService } from "../services/crm.service.js";
import {
    assertBrokerWorkspaceAccess,
    assertShipmentAccess,
    scopedBrokerId,
    teamScopeUserId,
} from "../../../auth/access.js";
import { canManageBrokers, isDataScopedRole, isTeamScopedRole } from "../../../auth/roles.js";
import { isBrokerOnTeam, listTeamBrokerIds } from "../../../auth/team-scope.js";
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
    const teamLeadId = teamScopeUserId(req) || undefined;
    const data = await crmService.getDashboard(teamLeadId ? { teamLeadId } : undefined);
    return res.json(
        apiResponse(
            true,
            teamLeadId ? "Team CRM dashboard" : "CRM dashboard",
            data
        )
    );
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
    const teamLeadId = teamScopeUserId(req);
    if (teamLeadId && requested) {
        const onTeam = await isBrokerOnTeam(teamLeadId, requested);
        if (!onTeam) {
            return res.status(403).json(apiResponse(false, "Forbidden — broker is not on your team"));
        }
    }
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const data = await crmService.listShipments({
        brokerId,
        status,
        teamLeadId: !brokerId && teamLeadId ? teamLeadId : undefined,
    });
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

export async function crmMarkShipmentOpenedController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    if (!req.user?.userId) return res.status(401).json(apiResponse(false, "Unauthorized"));
    const access = await assertShipmentAccess(req, res, id);
    if (!access.ok) return;

    // Manager/Owner previews must not change the assigned broker's workflow status.
    const card =
        req.user.role === "Broker"
            ? await crmService.markAgentOpened(id, req.user.userId)
            : await crmService.getShipmentCard(id);
    if (!card) return res.status(404).json(apiResponse(false, "Shipment not found"));
    return res.json(apiResponse(true, "Shipment open recorded", card));
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
    const teamLeadId = teamScopeUserId(req) || undefined;
    const data = await crmService.getBrokerWorkload(
        teamLeadId ? { teamLeadId } : undefined
    );
    return res.json(
        apiResponse(true, teamLeadId ? "Team brokers loaded" : "Brokers loaded", data)
    );
}

export async function crmBrokerWorkspaceController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    const allowed = await assertBrokerWorkspaceAccess(req, res, id);
    if (!allowed) return;
    if (
        !canManageBrokers(req.user?.role || "") &&
        !isDataScopedRole(req.user?.role || "") &&
        !isTeamScopedRole(req.user?.role || "")
    ) {
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
        const status =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(status || 500).json(apiResponse(false, message));
    }
}

/** Unique customers from broker's own shipments. */
export async function crmMyCustomersController(req: AuthRequest, res: Response) {
    const brokerId = scopedBrokerId(req);
    if (!brokerId && isDataScopedRole(req.user?.role || "")) {
        return res.status(401).json(apiResponse(false, "Unauthorized"));
    }
    const teamLeadId = teamScopeUserId(req);
    let where: Record<string, unknown> = {};
    if (brokerId) {
        where = { assignedBrokerId: brokerId };
    } else if (teamLeadId) {
        const ids = await listTeamBrokerIds(teamLeadId);
        where = { assignedBrokerId: { in: ids } };
    }
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

    const { platformNotificationService } = await import(
        "../../shipment/services/platform-notification.service.js"
    );
    const rows = await platformNotificationService.listForUser(userId, { limit: 100 });
    const unread = await platformNotificationService.unreadCount(userId);

    return res.json(
        apiResponse(true, "Notifications", {
            unread,
            items: rows.map((n) => ({
                id: n.notificationId,
                type: n.notificationType,
                title: n.title,
                message: n.message,
                status: n.status,
                shipmentLeadId: n.shipmentLeadId,
                createdAt: n.createdAt,
                readAt: n.readAt,
            })),
        })
    );
}

export async function crmMarkNotificationReadController(req: AuthRequest, res: Response) {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json(apiResponse(false, "Unauthorized"));
    const id = String(req.params.id);
    const { platformNotificationService } = await import(
        "../../shipment/services/platform-notification.service.js"
    );
    const row = await platformNotificationService.markRead(id, userId);
    if (!row) return res.status(404).json(apiResponse(false, "Notification not found"));
    return res.json(apiResponse(true, "Marked read", row));
}

export async function crmMarkAllNotificationsReadController(req: AuthRequest, res: Response) {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json(apiResponse(false, "Unauthorized"));
    const { platformNotificationService } = await import(
        "../../shipment/services/platform-notification.service.js"
    );
    const count = await platformNotificationService.markAllRead(userId);
    return res.json(apiResponse(true, "All marked read", { count }));
}

export async function crmCustomerDetailController(req: AuthRequest, res: Response) {
    const name = decodeURIComponent(String(req.params.name || "")).trim();
    if (!name) return res.status(422).json(apiResponse(false, "Customer name required"));

    const brokerId = scopedBrokerId(req);
    const teamLeadId = teamScopeUserId(req);
    const where: Record<string, unknown> = {
        customerName: { equals: name },
    };
    if (brokerId) {
        where.assignedBrokerId = brokerId;
    } else if (teamLeadId) {
        const teamIds = await listTeamBrokerIds(teamLeadId);
        where.assignedBrokerId = { in: teamIds.length ? teamIds : ["__none__"] };
    }

    const shipments = await prisma.shipmentLead.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: 200,
    });

    const ids = shipments.map((s) => s.shipmentLeadId);
    const [timeline, mailbox, events] = await Promise.all([
        ids.length
            ? prisma.shipmentTimelineEvent.findMany({
                  where: { shipmentLeadId: { in: ids } },
                  orderBy: { createdAt: "desc" },
                  take: 200,
              })
            : Promise.resolve([]),
        ids.length
            ? prisma.brokerMailboxMessage.findMany({
                  where: { shipmentLeadId: { in: ids } },
                  orderBy: { receivedAt: "desc" },
                  take: 100,
              })
            : Promise.resolve([]),
        ids.length
            ? prisma.domainEvent.findMany({
                  where: { shipmentLeadId: { in: ids } },
                  orderBy: { createdAt: "desc" },
                  take: 200,
              })
            : Promise.resolve([]),
    ]);

    const financial = {
        totalQuoted: shipments.reduce((a, s) => a + (s.price || 0), 0),
        withLoadNumber: shipments.filter((s) => s.loadNumber).length,
        completed: shipments.filter((s) =>
            ["COMPLETED", "CLOSED", "WON", "DELIVERED"].includes(s.status)
        ).length,
        lost: shipments.filter((s) => s.status === "LOST").length,
        active: shipments.filter((s) =>
            !["COMPLETED", "CLOSED", "WON", "LOST"].includes(s.status)
        ).length,
    };

    return res.json(
        apiResponse(true, "Customer", {
            customer: name,
            shipments,
            timeline,
            domainEvents: events,
            communications: mailbox,
            financial,
            documents: shipments.flatMap((s) => {
                try {
                    return s.documentsJson ? JSON.parse(s.documentsJson) : [];
                } catch {
                    return [];
                }
            }),
        })
    );
}
