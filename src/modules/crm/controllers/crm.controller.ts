import { Response } from "express";
import { apiResponse } from "../../../utils/helpers.js";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { crmService } from "../services/crm.service.js";
import { shipmentFilesService } from "../services/shipment-files.service.js";
import {
    assertBrokerWorkspaceAccess,
    assertShipmentAccess,
    scopedBrokerId,
    teamScopeUserId,
} from "../../../auth/access.js";
import { canManageBrokers, canViewLoadProfit, canWorkAnyShipment, isDataScopedRole, isTeamScopedRole } from "../../../auth/roles.js";
import { isBrokerOnTeam, listTeamBrokerIds } from "../../../auth/team-scope.js";
import { prisma } from "../../../config/database.js";
import path from "path";
import fs from "fs";
import type { RequestHandler } from "express";
import multer from "multer";
import os from "os";

const uploadTmp = multer({
    dest: path.join(os.tmpdir(), "greenos-uploads"),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

fs.mkdirSync(path.join(os.tmpdir(), "greenos-uploads"), { recursive: true });

export const crmUploadMiddleware: RequestHandler = uploadTmp.single("file");

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
    const shell = req.query.shell === "1";
    const data = await crmService.getDashboard(
        teamLeadId ? { teamLeadId, shell } : shell ? { shell } : undefined
    );
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
        lite: req.user?.role === "Broker",
    });
    return res.json(apiResponse(true, "Shipments loaded", data));
}

export async function crmGetShipmentController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    const access = await assertShipmentAccess(req, res, id);
    if (!access.ok) return;
    const card = await crmService.getShipmentCard(id);
    if (!card) return res.status(404).json(apiResponse(false, "Shipment not found"));

    const role = req.user?.role || "";
    const { canSeeOpsComments, listOpsComments } = await import(
        "../services/shipment-ops-comment.service.js"
    );
    if (canSeeOpsComments(role)) {
        const opsComments = await listOpsComments(id);
        return res.json(apiResponse(true, "OK", { ...card, opsComments }));
    }
    // Brokers never receive ops Comments (Team Lead ↔ Manager thread).
    const { opsComments: _omit, ...safe } = card as Record<string, unknown> & {
        opsComments?: unknown;
    };
    return res.json(apiResponse(true, "OK", safe));
}

export async function crmMarkShipmentOpenedController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    if (!req.user?.userId) return res.status(401).json(apiResponse(false, "Unauthorized"));
    const access = await assertShipmentAccess(req, res, id);
    if (!access.ok) return;

    const action =
        typeof req.body?.action === "string"
            ? req.body.action
            : typeof req.query?.action === "string"
              ? req.query.action
              : "";

    // Only explicit "Open in uShip" advances to AGENT_OPEN — viewing the card does not.
    const card =
        action === "uship" &&
        (req.user.role === "Broker" || canWorkAnyShipment(req.user.role))
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
        const code =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(code || 500).json(apiResponse(false, message));
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

/** TEST: simulate Customer Accepted email → ACCEPTED + auto Create Load (GL…). */
export async function crmTestCustomerAcceptController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    if (!req.user?.userId) return res.status(401).json(apiResponse(false, "Unauthorized"));
    const access = await assertShipmentAccess(req, res, id);
    if (!access.ok) return;
    try {
        const data = await crmService.simulateCustomerAccepted(id, req.user.userId);
        return res.json(
            apiResponse(
                true,
                "TEST: Customer Accepted simulated — Load Number created if missing",
                data
            )
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : "Test accept failed";
        const status =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(status || 500).json(apiResponse(false, message));
    }
}

export async function crmBrokerQuestionController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    if (!req.user?.userId) return res.status(401).json(apiResponse(false, "Unauthorized"));
    const access = await assertShipmentAccess(req, res, id);
    if (!access.ok) return;
    try {
        const note = typeof req.body?.note === "string" ? req.body.note : undefined;
        const data = await crmService.markBrokerQuestion(id, req.user.userId, note);
        return res.json(apiResponse(true, "Broker Question marked", data));
    } catch (err) {
        const message = err instanceof Error ? err.message : "Failed";
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
            customerEmail: true,
            customerPhone: true,
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
        {
            customer: string;
            gmail: string | null;
            phone: string | null;
            shipmentCount: number;
            lastShipmentId: string;
            lastStatus: string;
            lastUpdated: Date;
        }
    >();
    for (const r of rows) {
        const name = (r.customerName || "Unknown").trim() || "Unknown";
        const email = (r.customerEmail || "").trim() || null;
        const phone = (r.customerPhone || "").trim() || null;
        const prev = map.get(name);
        if (!prev) {
            map.set(name, {
                customer: name,
                gmail: email,
                phone,
                shipmentCount: 1,
                lastShipmentId: r.shipmentLeadId,
                lastStatus: r.status,
                lastUpdated: r.updatedAt,
            });
        } else {
            prev.shipmentCount += 1;
            // Keep newest contacts if later rows lack them (rows are newest-first).
            if (!prev.gmail && email) prev.gmail = email;
            if (!prev.phone && phone) prev.phone = phone;
        }
    }
    return res.json(apiResponse(true, "Customers", [...map.values()]));
}

/** Carriers that worked with this broker (from Operations on shipment cards). */
export async function crmMyCarriersController(req: AuthRequest, res: Response) {
    if (isDataScopedRole(req.user?.role || "") && !scopedBrokerId(req)) {
        return res.status(401).json(apiResponse(false, "Unauthorized"));
    }
    const brokerId = scopedBrokerId(req);
    const teamLeadId = teamScopeUserId(req);
    let where: Record<string, unknown> = {
        carrierName: { not: null },
        NOT: { carrierName: "" },
    };
    if (brokerId) {
        where.assignedBrokerId = brokerId;
    } else if (teamLeadId) {
        const ids = await listTeamBrokerIds(teamLeadId);
        where.assignedBrokerId = { in: ids.length ? ids : ["__none__"] };
    }

    const rows = await prisma.shipmentLead.findMany({
        where,
        select: {
            carrierName: true,
            driverName: true,
            truckNumber: true,
            trailerNumber: true,
            shipmentLeadId: true,
            greenOsShipmentId: true,
            loadNumber: true,
            status: true,
            pickupCity: true,
            pickupState: true,
            deliveryCity: true,
            deliveryState: true,
            updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 800,
    });

    type CarrierAgg = {
        carrier: string;
        shipmentCount: number;
        activeCount: number;
        lastStatus: string;
        lastUpdated: Date;
        lastShipmentId: string;
        drivers: string[];
    };
    const map = new Map<string, CarrierAgg>();
    const activeStatuses = new Set([
        "LOAD_CREATED",
        "DISPATCH",
        "PICKED_UP",
        "ACCEPTED",
        "BOOKED",
    ]);

    for (const r of rows) {
        const name = String(r.carrierName || "").trim();
        if (!name) continue;
        const key = name.toLowerCase();
        const prev = map.get(key);
        const isActive = activeStatuses.has(String(r.status || "").toUpperCase());
        if (!prev) {
            map.set(key, {
                carrier: name,
                shipmentCount: 1,
                activeCount: isActive ? 1 : 0,
                lastStatus: r.status,
                lastUpdated: r.updatedAt,
                lastShipmentId: r.shipmentLeadId,
                drivers: r.driverName ? [String(r.driverName).trim()] : [],
            });
        } else {
            prev.shipmentCount += 1;
            if (isActive) prev.activeCount += 1;
            if (r.driverName) {
                const d = String(r.driverName).trim();
                if (d && !prev.drivers.includes(d)) prev.drivers.push(d);
            }
        }
    }

    const list = [...map.values()].sort((a, b) => b.shipmentCount - a.shipmentCount);
    return res.json(apiResponse(true, "My Carriers", list));
}

/**
 * Drivers currently hauling loads (On Road) — DISPATCH / in-transit shipments.
 */
export async function crmOnRoadController(req: AuthRequest, res: Response) {
    if (isDataScopedRole(req.user?.role || "") && !scopedBrokerId(req)) {
        return res.status(401).json(apiResponse(false, "Unauthorized"));
    }
    const brokerId = scopedBrokerId(req);
    const teamLeadId = teamScopeUserId(req);
    let where: Record<string, unknown> = {
        status: { in: ["DISPATCH", "PICKED_UP"] },
    };
    if (brokerId) {
        where.assignedBrokerId = brokerId;
    } else if (teamLeadId) {
        const ids = await listTeamBrokerIds(teamLeadId);
        where.assignedBrokerId = { in: ids.length ? ids : ["__none__"] };
    }

    const rows = await prisma.shipmentLead.findMany({
        where,
        select: {
            shipmentLeadId: true,
            greenOsShipmentId: true,
            loadNumber: true,
            shipmentTitle: true,
            status: true,
            carrierName: true,
            driverName: true,
            truckNumber: true,
            trailerNumber: true,
            pickupCity: true,
            pickupState: true,
            deliveryCity: true,
            deliveryState: true,
            opsPickupAt: true,
            opsDeliveryAt: true,
            updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 300,
    });

    const items = rows.map((r) => ({
        shipmentLeadId: r.shipmentLeadId,
        greenOsShipmentId: r.greenOsShipmentId,
        loadNumber: r.loadNumber,
        shipmentTitle: r.shipmentTitle,
        status: r.status,
        carrier: r.carrierName || "—",
        driver: r.driverName || "—",
        truck: r.truckNumber || "—",
        trailer: r.trailerNumber || "—",
        pickup: [r.pickupCity, r.pickupState].filter(Boolean).join(", ") || "—",
        delivery: [r.deliveryCity, r.deliveryState].filter(Boolean).join(", ") || "—",
        opsPickupAt: r.opsPickupAt,
        opsDeliveryAt: r.opsDeliveryAt,
        updatedAt: r.updatedAt,
        onRoad: true,
    }));

    return res.json(
        apiResponse(true, "On Road", {
            count: items.length,
            items,
        })
    );
}

/**
 * Live trucking board — GPS-tracked loads + In Road trucks (broker-scoped).
 */
export async function crmTruckingController(req: AuthRequest, res: Response) {
    if (isDataScopedRole(req.user?.role || "") && !scopedBrokerId(req)) {
        return res.status(401).json(apiResponse(false, "Unauthorized"));
    }
    const brokerId = scopedBrokerId(req);
    const teamLeadId = teamScopeUserId(req);

    const leadScope: Record<string, unknown> = {};
    if (brokerId) {
        leadScope.assignedBrokerId = brokerId;
    } else if (teamLeadId) {
        const ids = await listTeamBrokerIds(teamLeadId);
        leadScope.assignedBrokerId = { in: ids.length ? ids : ["__none__"] };
    }

    const roadStatuses = [
        "CARRIER_ASSIGNED",
        "RATE_CON_GENERATED",
        "CARRIER_ACCEPTED",
        "PICKUP",
        "IN_TRANSIT",
        "DISPATCH",
        "PICKED_UP",
    ];

    const [gpsRows, roadLoads] = await Promise.all([
        prisma.shipmentTracking.findMany({
            where: {
                status: "ACTIVE",
                ...(Object.keys(leadScope).length
                    ? { shipmentLead: leadScope }
                    : {}),
            },
            include: {
                shipmentLead: {
                    select: {
                        shipmentLeadId: true,
                        greenOsShipmentId: true,
                        loadNumber: true,
                        shipmentTitle: true,
                        status: true,
                        customerName: true,
                        carrierName: true,
                        driverName: true,
                        driverPhone: true,
                        truckNumber: true,
                        trailerNumber: true,
                        pickupCity: true,
                        pickupState: true,
                        deliveryCity: true,
                        deliveryState: true,
                        assignedBrokerId: true,
                    },
                },
            },
            orderBy: { lastPositionAt: "desc" },
            take: 200,
        }),
        prisma.shipmentLead.findMany({
            where: {
                ...leadScope,
                status: { in: roadStatuses },
                OR: [{ truckNumber: { not: null } }, { driverName: { not: null } }],
            },
            select: {
                shipmentLeadId: true,
                greenOsShipmentId: true,
                loadNumber: true,
                shipmentTitle: true,
                status: true,
                customerName: true,
                carrierName: true,
                driverName: true,
                driverPhone: true,
                truckNumber: true,
                trailerNumber: true,
                pickupCity: true,
                pickupState: true,
                deliveryCity: true,
                deliveryState: true,
                updatedAt: true,
            },
            orderBy: { updatedAt: "desc" },
            take: 200,
        }),
    ]);

    const gpsByLead = new Map(gpsRows.map((g) => [g.shipmentLeadId, g]));

    type TruckRow = {
        shipmentLeadId: string;
        greenOsShipmentId: string | null;
        loadNumber: string | null;
        shipmentTitle: string | null;
        status: string;
        customer: string;
        carrier: string;
        driver: string;
        driverPhone: string;
        truck: string;
        trailer: string;
        pickup: string;
        delivery: string;
        online: boolean;
        provider: string | null;
        providerLoadId: string | null;
        latitude: number | null;
        longitude: number | null;
        address: string | null;
        lastPositionAt: Date | null;
        movementType: string | null;
        routeStarted: boolean;
        driverIsLate: boolean;
        timeLeftSec: number | null;
        distanceLeftMeters: number | null;
        trackingUrl: string | null;
        clientTrackingUrl: string | null;
    };

    const trucks: TruckRow[] = gpsRows.map((g) => {
        const s = g.shipmentLead;
        return {
            shipmentLeadId: s.shipmentLeadId,
            greenOsShipmentId: s.greenOsShipmentId,
            loadNumber: s.loadNumber,
            shipmentTitle: s.shipmentTitle,
            status: s.status,
            customer: s.customerName || "—",
            carrier: s.carrierName || "—",
            driver: s.driverName || "—",
            driverPhone: g.driverPhone || s.driverPhone || "—",
            truck: s.truckNumber || "—",
            trailer: s.trailerNumber || "—",
            pickup: [s.pickupCity, s.pickupState].filter(Boolean).join(", ") || "—",
            delivery: [s.deliveryCity, s.deliveryState].filter(Boolean).join(", ") || "—",
            online: true,
            provider: g.provider,
            providerLoadId: g.providerLoadId,
            latitude: g.lastLatitude,
            longitude: g.lastLongitude,
            address: g.lastAddress,
            lastPositionAt: g.lastPositionAt,
            movementType: g.movementType,
            routeStarted: g.routeStarted,
            driverIsLate: g.driverIsLate,
            timeLeftSec: g.timeLeftSec,
            distanceLeftMeters: g.distanceLeftMeters,
            trackingUrl: g.trackingUrl,
            clientTrackingUrl: g.clientTrackingUrl,
        };
    });

    for (const s of roadLoads) {
        if (gpsByLead.has(s.shipmentLeadId)) continue;
        trucks.push({
            shipmentLeadId: s.shipmentLeadId,
            greenOsShipmentId: s.greenOsShipmentId,
            loadNumber: s.loadNumber,
            shipmentTitle: s.shipmentTitle,
            status: s.status,
            customer: s.customerName || "—",
            carrier: s.carrierName || "—",
            driver: s.driverName || "—",
            driverPhone: s.driverPhone || "—",
            truck: s.truckNumber || "—",
            trailer: s.trailerNumber || "—",
            pickup: [s.pickupCity, s.pickupState].filter(Boolean).join(", ") || "—",
            delivery: [s.deliveryCity, s.deliveryState].filter(Boolean).join(", ") || "—",
            online: false,
            provider: null,
            providerLoadId: null,
            latitude: null,
            longitude: null,
            address: null,
            lastPositionAt: null,
            movementType: null,
            routeStarted: false,
            driverIsLate: false,
            timeLeftSec: null,
            distanceLeftMeters: null,
            trackingUrl: null,
            clientTrackingUrl: null,
        });
    }

    trucks.sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        const ta = a.lastPositionAt ? new Date(a.lastPositionAt).getTime() : 0;
        const tb = b.lastPositionAt ? new Date(b.lastPositionAt).getTime() : 0;
        return tb - ta;
    });

    return res.json(
        apiResponse(true, "Trucking", {
            count: trucks.length,
            onlineCount: trucks.filter((t) => t.online).length,
            updatedAt: new Date().toISOString(),
            items: trucks,
        })
    );
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

    let gmail: string | null = null;
    let phone: string | null = null;
    for (const s of shipments) {
        if (!gmail && s.customerEmail) gmail = s.customerEmail;
        if (!phone && s.customerPhone) phone = s.customerPhone;
        if (gmail && phone) break;
    }

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

    const financial = (() => {
        let fromCustomer = 0; // взяли у кастомера (Customer Invoice / customerRate)
        let toCarrier = 0; // отдали кериеру (Rate Con / Carrier Invoice / carrierRate)
        for (const s of shipments) {
            const cust = Number(s.customerRate ?? s.price ?? 0);
            const carr = Number(s.carrierRate ?? 0);
            if (Number.isFinite(cust)) fromCustomer += cust;
            if (Number.isFinite(carr)) toCarrier += carr;
        }
        // Profit = what we took from customer − what we paid carrier
        const profit = fromCustomer - toCarrier;
        return {
            totalQuoted: fromCustomer,
            totalSold: fromCustomer,
            totalPaid: toCarrier,
            fromCustomer,
            toCarrier,
            profit,
            withLoadNumber: shipments.filter((s) => s.loadNumber).length,
            completed: shipments.filter((s) =>
                ["COMPLETED", "CLOSED", "WON", "DELIVERED"].includes(s.status)
            ).length,
            lost: shipments.filter((s) => s.status === "LOST").length,
            active: shipments.filter((s) =>
                !["COMPLETED", "CLOSED", "WON", "LOST"].includes(s.status)
            ).length,
        };
    })();

    const role = req.user?.role || "";
    const showMoney = canViewLoadProfit(role);
    const shipmentsOut = showMoney
        ? shipments
        : shipments.map((s) => {
              const { customerRate: _c, carrierRate: _r, price: _p, ...rest } = s as typeof s & {
                  customerRate?: unknown;
                  carrierRate?: unknown;
                  price?: unknown;
              };
              return rest;
          });

    return res.json(
        apiResponse(true, "Customer", {
            customer: name,
            contact: { gmail, phone },
            shipments: shipmentsOut,
            timeline,
            domainEvents: events,
            communications: mailbox,
            financial: showMoney
                ? financial
                : {
                      restricted: true,
                      active: financial.active,
                      completed: financial.completed,
                      lost: financial.lost,
                      withLoadNumber: financial.withLoadNumber,
                  },
            canViewMoney: showMoney,
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

export async function crmUploadShipmentFileController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    const access = await assertShipmentAccess(req, res, id);
    if (!access.ok) return;

    const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
    if (!file) {
        return res.status(422).json(apiResponse(false, "Choose a file to upload"));
    }

    try {
        const doc = await shipmentFilesService.attachUploadedFile({
            shipmentLeadId: id,
            originalName: file.originalname,
            mimeType: file.mimetype,
            size: file.size,
            tempPath: file.path,
            uploadedBy: req.user?.userId,
        });
        const card = await crmService.getShipmentCard(id);
        return res.json(apiResponse(true, "File uploaded", { document: doc, card }));
    } catch (err) {
        if (file.path && fs.existsSync(file.path)) {
            try {
                fs.unlinkSync(file.path);
            } catch {
                /* ignore */
            }
        }
        const message = err instanceof Error ? err.message : "Upload failed";
        const code =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(code || 500).json(apiResponse(false, message));
    }
}

export async function crmDownloadShipmentFileController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    const fileId = String(req.params.fileId);
    const access = await assertShipmentAccess(req, res, id);
    if (!access.ok) return;

    const resolved = await shipmentFilesService.resolveFilePath(id, fileId);
    if (!resolved) {
        return res.status(404).json(apiResponse(false, "File not found"));
    }

    res.setHeader(
        "Content-Type",
        resolved.doc.mimeType || "application/octet-stream"
    );
    res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(resolved.doc.name)}"`
    );
    return res.sendFile(path.resolve(resolved.absolutePath));
}

export async function crmDeleteShipmentFileController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    const fileId = String(req.params.fileId);
    const access = await assertShipmentAccess(req, res, id);
    if (!access.ok) return;

    try {
        const ok = await shipmentFilesService.removeFile(id, fileId);
        if (!ok) return res.status(404).json(apiResponse(false, "File not found"));
        const card = await crmService.getShipmentCard(id);
        return res.json(apiResponse(true, "File removed", card));
    } catch (err) {
        const message = err instanceof Error ? err.message : "Delete failed";
        const code =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(code || 500).json(apiResponse(false, message));
    }
}

/** Archive: Customer Respond with no Broker Answer after 10 minutes. */
export async function crmListProblemsController(req: AuthRequest, res: Response) {
    const role = req.user?.role || "";
    if (
        role !== "Administrator" &&
        role !== "Owner" &&
        role !== "Manager" &&
        role !== "Team Lead"
    ) {
        return res.status(403).json(apiResponse(false, "Forbidden"));
    }
    const { listBrokerResponseProblems } = await import(
        "../services/broker-response-problem.service.js"
    );
    const teamLeadId = teamScopeUserId(req);
    const rows = await listBrokerResponseProblems({
        teamLeadId: teamLeadId || undefined,
        limit: 300,
    });
    return res.json(
        apiResponse(true, "Problems loaded", {
            scope: teamLeadId ? "team" : "company",
            items: rows,
        })
    );
}

/** Month-end picture: which broker missed how many times + TL reminders. */
export async function crmProblemsMonthlyStatsController(req: AuthRequest, res: Response) {
    const role = req.user?.role || "";
    if (
        role !== "Administrator" &&
        role !== "Owner" &&
        role !== "Manager" &&
        role !== "Team Lead"
    ) {
        return res.status(403).json(apiResponse(false, "Forbidden"));
    }
    const { monthlyBrokerResponseStats } = await import(
        "../services/broker-response-problem.service.js"
    );
    const teamLeadId = teamScopeUserId(req);
    const year = req.query.year ? Number(req.query.year) : undefined;
    const month = req.query.month ? Number(req.query.month) : undefined;
    const data = await monthlyBrokerResponseStats({
        teamLeadId: teamLeadId || undefined,
        year: Number.isFinite(year) ? year : undefined,
        month: Number.isFinite(month) ? month : undefined,
    });
    return res.json(
        apiResponse(true, "Monthly problem stats", {
            scope: teamLeadId ? "team" : "company",
            ...data,
        })
    );
}

/** Problems → Late: pickup/delivery overdue by 15+ minutes. */
export async function crmListLateProblemsController(req: AuthRequest, res: Response) {
    const role = req.user?.role || "";
    if (
        role !== "Administrator" &&
        role !== "Owner" &&
        role !== "Manager" &&
        role !== "Team Lead"
    ) {
        return res.status(403).json(apiResponse(false, "Forbidden"));
    }
    const { listLoadLateProblems } = await import(
        "../services/load-late-problem.service.js"
    );
    const teamLeadId = teamScopeUserId(req);
    const kindRaw = typeof req.query.kind === "string" ? req.query.kind.toUpperCase() : "";
    const lateKind =
        kindRaw === "PICKUP" || kindRaw === "DELIVERY" ? kindRaw : undefined;
    const rows = await listLoadLateProblems({
        teamLeadId: teamLeadId || undefined,
        lateKind,
        limit: 400,
    });
    return res.json(
        apiResponse(true, "Late problems loaded", {
            scope: teamLeadId ? "team" : "company",
            items: rows,
        })
    );
}

/** Team Lead / Manager / Owner Comments on a broker shipment (hidden from Broker). */
export async function crmAddOpsCommentController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    if (!req.user?.userId) return res.status(401).json(apiResponse(false, "Unauthorized"));
    const access = await assertShipmentAccess(req, res, id);
    if (!access.ok) return;

    const role = req.user.role || "";
    const { addOpsComment, listOpsComments, canSeeOpsComments } = await import(
        "../services/shipment-ops-comment.service.js"
    );
    if (!canSeeOpsComments(role)) {
        return res.status(403).json(apiResponse(false, "Forbidden — Brokers cannot use Comments"));
    }

    try {
        const body = String(req.body?.body || req.body?.comment || "");
        const sendToManager = Boolean(req.body?.sendToManager);
        await addOpsComment({
            shipmentLeadId: id,
            authorUserId: req.user.userId,
            authorRole: role,
            body,
            sendToManager,
        });
        const card = await crmService.getShipmentCard(id);
        const opsComments = await listOpsComments(id);
        return res.json(
            apiResponse(true, sendToManager ? "Comment sent to Manager" : "Comment saved", {
                ...card,
                opsComments,
            })
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : "Comment failed";
        const code =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(code || 500).json(apiResponse(false, message));
    }
}

export async function crmSendOpsCommentToManagerController(req: AuthRequest, res: Response) {
    const id = String(req.params.id);
    const commentId = String(req.params.commentId);
    if (!req.user?.userId) return res.status(401).json(apiResponse(false, "Unauthorized"));
    const access = await assertShipmentAccess(req, res, id);
    if (!access.ok) return;

    const role = req.user.role || "";
    const { sendOpsCommentToManager, listOpsComments, canSeeOpsComments } = await import(
        "../services/shipment-ops-comment.service.js"
    );
    if (!canSeeOpsComments(role)) {
        return res.status(403).json(apiResponse(false, "Forbidden"));
    }

    try {
        await sendOpsCommentToManager({
            shipmentLeadId: id,
            commentId,
            actorUserId: req.user.userId,
            actorRole: role,
        });
        const card = await crmService.getShipmentCard(id);
        const opsComments = await listOpsComments(id);
        return res.json(
            apiResponse(true, "Sent to Manager", {
                ...card,
                opsComments,
            })
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : "Send failed";
        const code =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(code || 500).json(apiResponse(false, message));
    }
}
