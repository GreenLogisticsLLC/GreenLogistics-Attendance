import { prisma } from "../../../config/database.js";
import { config } from "../../../config/env.js";
import { getInOfficeEmployeeIds } from "../../../services/attendance-presence.service.js";
import { ACTIVE_STATUSES } from "../crm.constants.js";
import { AUTO_PIPELINE_STATUSES } from "../../shipment/shipment.constants.js";
import { domainEventEngine } from "../../shipment/services/domain-event.engine.js";
import { shipmentService } from "../../shipment/services/shipment.service.js";
import { ensureGreenOsShipmentId } from "../../shipment/shipment.id.js";
import { isLoadPhase, normalizeStatus, statusLabel } from "../../shipment/shipment.lifecycle.js";
import { listTeamBrokerIds } from "../../../auth/team-scope.js";
import { canWorkAnyShipment } from "../../../auth/roles.js";

async function actorRoleName(userId: string): Promise<string> {
    const user = await prisma.user.findUnique({
        where: { userId },
        select: { role: { select: { roleName: true } } },
    });
    return user?.role?.roleName || "";
}

function startOfToday(timezone: string): Date {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    // Approximate midnight local as UTC date string — good enough for KPI buckets
    return new Date(`${y}-${m}-${d}T00:00:00`);
}

function place(city?: string | null, state?: string | null, zip?: string | null) {
    return [city, state, zip].filter(Boolean).join(", ") || "—";
}

function brokerName(u: { firstName: string; lastName: string; username: string } | null | undefined) {
    if (!u) return "Unassigned";
    const n = `${u.firstName || ""} ${u.lastName || ""}`.trim();
    return n || u.username;
}

type BrokerUser = {
    userId: string;
    firstName: string;
    lastName: string;
    username: string;
    isActive: boolean;
};

async function userMap(ids: string[]): Promise<Map<string, BrokerUser>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const users = await prisma.user.findMany({
        where: { userId: { in: unique } },
        select: { userId: true, firstName: true, lastName: true, username: true, isActive: true },
    });
    return new Map(users.map((u: BrokerUser) => [u.userId, u]));
}

function enrichLead(lead: Record<string, unknown>, brokers: Map<string, BrokerUser>) {
    const brokerId = lead.assignedBrokerId as string | null;
    const broker = brokerId ? brokers.get(brokerId) : undefined;
    return {
        ...lead,
        customer: (lead.customerName as string) || "—",
        brokerName: brokerName(broker),
        brokerOnline: broker ? broker.isActive : false,
        pickup: place(lead.pickupCity as string, lead.pickupState as string, lead.pickupZip as string),
        delivery: place(lead.deliveryCity as string, lead.deliveryState as string, lead.deliveryZip as string),
        equipment: (lead.equipment as string) || (lead.category as string) || "—",
        vehicle: (lead.vehicle as string) || (lead.category as string) || "—",
        statusLabel: statusLabel(String(lead.status || "")),
        greenOsShipmentId: (lead.greenOsShipmentId as string) || null,
        loadNumber: (lead.loadNumber as string) || null,
        carrierName: (lead.carrierName as string) || null,
        driverName: (lead.driverName as string) || null,
        truckNumber: (lead.truckNumber as string) || null,
        trailerNumber: (lead.trailerNumber as string) || null,
        rateConfirmation: (lead.rateConfirmation as string) || null,
        podUrl: (lead.podUrl as string) || null,
        invoiceNumber: (lead.invoiceNumber as string) || null,
        paymentStatus: (lead.paymentStatus as string) || null,
        opsPickupAt: lead.opsPickupAt || null,
        opsDeliveryAt: lead.opsDeliveryAt || null,
        ushipUrl: (function ushipListingUrl() {
            const view = String(lead.viewUrl || "").trim();
            if (view) return view;
            const ext = String(lead.externalShipmentId || "").trim();
            if (/^\d{5,}$/.test(ext)) return `https://www.uship.com/listing/${ext}`;
            return null;
        })(),
    };
}

/** List table columns only — skips heavy JSON/text blobs. */
const SHIPMENT_LIST_SELECT = {
    shipmentLeadId: true,
    greenOsShipmentId: true,
    shipmentTitle: true,
    customerName: true,
    pickupCity: true,
    pickupState: true,
    pickupZip: true,
    deliveryCity: true,
    deliveryState: true,
    deliveryZip: true,
    miles: true,
    category: true,
    equipment: true,
    vehicle: true,
    price: true,
    priority: true,
    status: true,
    loadNumber: true,
    viewUrl: true,
    assignedBrokerId: true,
    isReassignment: true,
    wasEverReassigned: true,
    createdAt: true,
    updatedAt: true,
    receivedAt: true,
} as const;

function toBrokerListRow(lead: Record<string, unknown>, brokers: Map<string, BrokerUser>) {
    const e = enrichLead(lead, brokers);
    return {
        shipmentLeadId: lead.shipmentLeadId as string,
        greenOsShipmentId: e.greenOsShipmentId,
        shipmentTitle: lead.shipmentTitle as string,
        customer: e.customer,
        pickup: e.pickup,
        delivery: e.delivery,
        status: lead.status as string,
        statusLabel: e.statusLabel,
        isReassignment: Boolean(lead.isReassignment || lead.wasEverReassigned),
        wasEverReassigned: Boolean(lead.wasEverReassigned || lead.isReassignment),
        updatedAt: lead.updatedAt as Date | string | null,
    };
}

export class CrmService {
    async getDashboard(options?: { teamLeadId?: string; shell?: boolean }) {
        const todayStart = startOfToday(config.timezone);
        const teamBrokerIds = options?.teamLeadId
            ? await listTeamBrokerIds(options.teamLeadId)
            : null;
        const teamAssigned =
            teamBrokerIds != null
                ? { assignedBrokerId: { in: teamBrokerIds } }
                : {};
        const unassignedWhere = {
            status: { in: ["NEW", "UNASSIGNED"] },
            OR: [{ assignedBrokerId: null }, { assignedBrokerId: "" }],
        };

        const shell = options?.shell === true;

        const countQueries = Promise.all([
            prisma.shipmentLead.count({
                where: {
                    createdAt: { gte: todayStart },
                    ...(teamBrokerIds
                        ? {
                              OR: [
                                  { assignedBrokerId: { in: teamBrokerIds } },
                                  unassignedWhere,
                              ],
                          }
                        : {}),
                },
            }),
            prisma.shipmentLead.count({ where: unassignedWhere }),
            prisma.shipmentLead.count({
                where: { status: "AWAITING_ACCEPTANCE", ...teamAssigned },
            }),
            prisma.shipmentLead.count({
                where: { status: "WORKING", ...teamAssigned },
            }),
            prisma.shipmentLead.count({
                where: { status: "QUOTE_SENT", ...teamAssigned },
            }),
            prisma.shipmentLead.count({
                where: { status: "WON", ...teamAssigned },
            }),
            prisma.shipmentLead.count({
                where: { status: { in: ["LOST", "ACCEPTED_ANOTHER_COMPANY"] }, ...teamAssigned },
            }),
            prisma.shipmentLead.count({
                where: { status: { in: [...ACTIVE_STATUSES] }, ...teamAssigned },
            }),
        ]);

        if (shell) {
            const [counts, presenceSummary, recentAssignedRows] = await Promise.all([
                countQueries,
                this.getBrokerPresenceSummary(
                    options?.teamLeadId ? { teamLeadId: options.teamLeadId } : undefined
                ),
                prisma.shipmentLead.findMany({
                    where: {
                        assignedBrokerId: { not: null },
                        assignedAt: { not: null },
                        ...(teamBrokerIds
                            ? { assignedBrokerId: { in: teamBrokerIds } }
                            : {}),
                    },
                    orderBy: { assignedAt: "desc" },
                    take: 15,
                }),
            ]);
            const [
                newToday,
                unassignedCount,
                awaiting,
                working,
                quotesSent,
                won,
                lost,
                active,
            ] = counts;

            const brokerIdsForMap = recentAssignedRows
                .map((r) => r.assignedBrokerId)
                .filter(Boolean) as string[];
            const brokersById = await userMap(brokerIdsForMap);

            return {
                version: "1.0",
                scope: options?.teamLeadId ? "team" : "company",
                teamBrokerCount: teamBrokerIds?.length ?? null,
                kpis: {
                    newShipmentsToday: newToday,
                    unassigned: unassignedCount,
                    awaitingAcceptance: awaiting,
                    working,
                    quotesSent,
                    won,
                    lost,
                    activeShipments: active,
                    ownerActiveLoads: presenceSummary.ownerActiveLoads,
                    shipmentsToPresentBrokers: presenceSummary.shipmentsToPresentBrokers,
                    brokersPresent: presenceSummary.presentBrokerCount,
                    assignmentMode: presenceSummary.assignmentMode,
                    averageResponseTimeMinutes: null,
                },
                recentlyAssigned: recentAssignedRows.map((row) =>
                    enrichLead(row as unknown as Record<string, unknown>, brokersById)
                ),
            };
        }

        const [counts, brokers, unassignedRows, recentAssignedRows] = await Promise.all([
            countQueries,
            this.getBrokerWorkload(options?.teamLeadId ? { teamLeadId: options.teamLeadId } : undefined),
            prisma.shipmentLead.findMany({
                where: unassignedWhere,
                orderBy: { createdAt: "asc" },
                take: 50,
            }),
            prisma.shipmentLead.findMany({
                where: {
                    assignedBrokerId: { not: null },
                    assignedAt: { not: null },
                    ...(teamBrokerIds
                        ? { assignedBrokerId: { in: teamBrokerIds } }
                        : {}),
                },
                orderBy: { assignedAt: "desc" },
                take: 30,
            }),
        ]);
        const [
            newToday,
            unassignedCount,
            awaiting,
            working,
            quotesSent,
            won,
            lost,
            active,
        ] = counts;

        const brokerIdsForMap = [
            ...unassignedRows.map((r) => r.assignedBrokerId),
            ...recentAssignedRows.map((r) => r.assignedBrokerId),
        ].filter(Boolean) as string[];
        const brokersById = await userMap(brokerIdsForMap);
        const avgResponseMs = await this.averageResponseTimeMs(teamBrokerIds || undefined);

        const presentBrokers = brokers.filter((b) => b.inOffice && b.role === "Broker");
        const shipmentsToPresentBrokers = presentBrokers.reduce(
            (sum, b) => sum + (b.currentShipments || 0),
            0
        );
        const shipmentsToAllAssignedBrokers = brokers
            .filter((b) => b.role === "Broker")
            .reduce((sum, b) => sum + (b.currentShipments || 0), 0);
        const assignmentMode =
            presentBrokers.length > 0 ? "in_office" : "all_brokers_fallback";
        // Owner "Active Loads": shipments currently with who should receive mail —
        // checked-in brokers when anyone is present; otherwise all brokers who have work.
        const ownerActiveLoads =
            presentBrokers.length > 0
                ? shipmentsToPresentBrokers
                : shipmentsToAllAssignedBrokers;

        return {
            version: "1.0",
            scope: options?.teamLeadId ? "team" : "company",
            teamBrokerCount: teamBrokerIds?.length ?? null,
            kpis: {
                newShipmentsToday: newToday,
                unassigned: unassignedCount,
                awaitingAcceptance: awaiting,
                working,
                quotesSent,
                won,
                lost,
                activeShipments: active,
                ownerActiveLoads,
                shipmentsToPresentBrokers,
                brokersPresent: presentBrokers.length,
                assignmentMode,
                averageResponseTimeMinutes: avgResponseMs == null ? null : Math.round(avgResponseMs / 60000),
            },
            unassignedShipments: unassignedRows.map((row) =>
                enrichLead(row as unknown as Record<string, unknown>, brokersById)
            ),
            recentlyAssigned: recentAssignedRows.map((row) =>
                enrichLead(row as unknown as Record<string, unknown>, brokersById)
            ),
            brokerWorkload: brokers.map((b) => ({
                brokerId: b.brokerId,
                name: b.name,
                activeShipments: b.currentShipments,
                inOffice: b.inOffice,
            })),
        };
    }

    private async averageResponseTimeMs(teamBrokerIds?: string[]): Promise<number | null> {
        const rows = await prisma.shipmentLead.findMany({
            where: {
                assignedAt: { not: null },
                acceptedAt: { not: null },
                ...(teamBrokerIds ? { assignedBrokerId: { in: teamBrokerIds } } : {}),
            },
            select: { assignedAt: true, acceptedAt: true },
            take: 500,
            orderBy: { acceptedAt: "desc" },
        });
        const diffs = rows
            .filter((r) => r.assignedAt && r.acceptedAt)
            .map((r) => r.acceptedAt!.getTime() - r.assignedAt!.getTime())
            .filter((ms) => ms >= 0);
        if (!diffs.length) return null;
        return diffs.reduce((a, b) => a + b, 0) / diffs.length;
    }

    async listShipments(options?: {
        brokerId?: string;
        status?: string;
        limit?: number;
        teamLeadId?: string;
        /** Broker My Shipments — slim payload, no heavy blobs. */
        lite?: boolean;
        /** new | other — filter by first-time vs passed-from-another-broker assignment. */
        assignmentKind?: "new" | "other";
    }) {
        if (options?.lite || options?.assignmentKind) {
            try {
                const { assignmentEngine } = await import(
                    "../../assignment/assignment.engine.js"
                );
                await assignmentEngine.repairPassedShipmentFlags();
            } catch {
                /* listing still works if repair is busy */
            }
        }

        const where: Record<string, unknown> = {};
        if (options?.brokerId) {
            where.assignedBrokerId = options.brokerId;
        } else if (options?.teamLeadId) {
            const teamBrokerIds = await listTeamBrokerIds(options.teamLeadId);
            where.OR = [
                { assignedBrokerId: { in: teamBrokerIds } },
                {
                    status: { in: ["NEW", "UNASSIGNED"] },
                    OR: [{ assignedBrokerId: null }, { assignedBrokerId: "" }],
                },
            ];
        }
        if (options?.status) where.status = options.status;
        if (options?.assignmentKind === "new") {
            where.isReassignment = false;
            where.wasEverReassigned = false;
        } else if (options?.assignmentKind === "other") {
            const passed = {
                OR: [{ isReassignment: true }, { wasEverReassigned: true }],
            };
            where.AND = [...(Array.isArray(where.AND) ? where.AND : []), passed];
        }

        const lite = options?.lite === true;
        const rows = await prisma.shipmentLead.findMany({
            where,
            orderBy: { updatedAt: "desc" },
            take: options?.limit ?? (lite ? 150 : 300),
            select: SHIPMENT_LIST_SELECT,
        });
        const brokers = await userMap(rows.map((r) => r.assignedBrokerId || ""));
        if (lite) {
            return rows.map((r) => toBrokerListRow(r as unknown as Record<string, unknown>, brokers));
        }
        return rows.map((r) => enrichLead(r as unknown as Record<string, unknown>, brokers));
    }

    async getShipmentCard(id: string) {
        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: id },
            include: {
                emailMessage: true,
                timelineEvents: { orderBy: { createdAt: "asc" }, take: 80 },
                importLogs: { orderBy: { createdAt: "desc" }, take: 30 },
                domainEvents: { orderBy: { createdAt: "desc" }, take: 120 },
            },
        });
        if (!lead) return null;

        const greenOsPromise = lead.greenOsShipmentId
            ? Promise.resolve(lead.greenOsShipmentId)
            : ensureGreenOsShipmentId(lead.shipmentLeadId).catch(() => lead.greenOsShipmentId);

        const [
            greenOsShipmentId,
            brokers,
            pipeline,
            correspondence,
            mailboxEmails,
            trustedBrokerGmailMessageIds,
        ] =
            await Promise.all([
                greenOsPromise,
                userMap(lead.assignedBrokerId ? [lead.assignedBrokerId] : []),
                domainEventEngine.buildLifecyclePipeline(lead.shipmentLeadId),
                domainEventEngine.correspondenceForDisplay(lead.shipmentLeadId),
                prisma.brokerMailboxMessage.findMany({
                    where: { shipmentLeadId: lead.shipmentLeadId },
                    orderBy: { receivedAt: "asc" },
                    take: 80,
                    select: {
                        messageId: true,
                        gmailMessageId: true,
                        subject: true,
                        fromAddress: true,
                        snippet: true,
                        receivedAt: true,
                        matchMethod: true,
                        userId: true,
                    },
                }),
                domainEventEngine.trustedBrokerGmailMessageIds(lead.shipmentLeadId),
            ]);
        const cardMailboxEmails = mailboxEmails.filter((message) =>
            trustedBrokerGmailMessageIds.has(message.gmailMessageId)
        );
        const cardTimeline = lead.timelineEvents.filter((event) =>
            domainEventEngine.artifactBelongsToShipment(
                event.metaJson,
                trustedBrokerGmailMessageIds
            )
        );
        const cardDomainEvents = lead.domainEvents.filter((event) =>
            domainEventEngine.artifactBelongsToShipment(
                event.payloadJson,
                trustedBrokerGmailMessageIds
            )
        );

        const enriched = enrichLead(
            {
                ...(lead as unknown as Record<string, unknown>),
                greenOsShipmentId: greenOsShipmentId || lead.greenOsShipmentId,
            },
            brokers
        );

        let documents: unknown[] = [];
        try {
            documents = lead.documentsJson ? JSON.parse(lead.documentsJson) : [];
        } catch {
            documents = [];
        }

        return {
            ...enriched,
            documents,
            correspondence,
            timeline: cardTimeline,
            // Queried newest-first for speed; expose oldest→newest for the card UI.
            domainEvents: [...cardDomainEvents].reverse(),
            pipeline,
            mailboxEmails: cardMailboxEmails,
            email: lead.emailMessage
                ? {
                      subject: lead.emailMessage.subject,
                      from: lead.emailMessage.fromAddress,
                      receivedAt: lead.emailMessage.receivedAt,
                  }
                : null,
        };
    }

    private async getBrokerPresenceSummary(options?: { teamLeadId?: string }) {
        const brokers = await prisma.user.findMany({
            where: {
                isActive: true,
                role: { roleName: { in: ["Broker", "Manager", "Owner"] } },
                ...(options?.teamLeadId ? { teamLeadId: options.teamLeadId } : {}),
            },
            select: {
                userId: true,
                employeeId: true,
                role: { select: { roleName: true } },
            },
        });
        const brokerOnly = brokers.filter((b) => b.role.roleName === "Broker");
        const pool = brokerOnly.length ? brokerOnly : brokers;
        const poolIds = pool.map((b) => b.userId);
        const employeeIds = pool
            .map((b) => b.employeeId)
            .filter((id): id is string => Boolean(id));

        const [inOfficeIds, activeCounts] = await Promise.all([
            getInOfficeEmployeeIds(employeeIds),
            prisma.shipmentLead.groupBy({
                by: ["assignedBrokerId"],
                where: {
                    status: { in: [...ACTIVE_STATUSES] },
                    assignedBrokerId: { in: poolIds },
                },
                _count: { _all: true },
            }),
        ]);

        const activeByBroker = new Map(
            activeCounts.map((row) => [row.assignedBrokerId, row._count._all])
        );
        const presentBrokers = pool.filter(
            (b) =>
                b.role.roleName === "Broker" &&
                b.employeeId &&
                inOfficeIds.has(b.employeeId)
        );
        const shipmentsToPresentBrokers = presentBrokers.reduce(
            (sum, b) => sum + (activeByBroker.get(b.userId) || 0),
            0
        );
        const shipmentsToAllAssignedBrokers = pool
            .filter((b) => b.role.roleName === "Broker")
            .reduce((sum, b) => sum + (activeByBroker.get(b.userId) || 0), 0);

        return {
            presentBrokerCount: presentBrokers.length,
            assignmentMode:
                presentBrokers.length > 0
                    ? ("in_office" as const)
                    : ("all_brokers_fallback" as const),
            ownerActiveLoads:
                presentBrokers.length > 0
                    ? shipmentsToPresentBrokers
                    : shipmentsToAllAssignedBrokers,
            shipmentsToPresentBrokers,
        };
    }

    async getBrokerWorkload(options?: { teamLeadId?: string }) {
        const brokers = await prisma.user.findMany({
            where: {
                isActive: true,
                role: { roleName: { in: ["Broker", "Manager", "Owner"] } },
                ...(options?.teamLeadId ? { teamLeadId: options.teamLeadId } : {}),
            },
            include: {
                role: true,
                teamLead: { select: { userId: true, firstName: true, lastName: true, username: true } },
            },
            orderBy: { firstName: "asc" },
        });
        const preferred = brokers.filter((b) => b.role.roleName === "Broker");
        const pool = preferred.length ? preferred : brokers;
        const poolIds = pool.map((b) => b.userId);
        const employeeIds = pool
            .map((b) => b.employeeId)
            .filter((id): id is string => Boolean(id));

        const [statusCounts, acceptedRows, inOfficeIds] = await Promise.all([
            prisma.shipmentLead.groupBy({
                by: ["assignedBrokerId", "status"],
                where: { assignedBrokerId: { in: poolIds } },
                _count: { _all: true },
            }),
            prisma.shipmentLead.findMany({
                where: {
                    assignedBrokerId: { in: poolIds },
                    assignedAt: { not: null },
                    acceptedAt: { not: null },
                },
                select: { assignedBrokerId: true, assignedAt: true, acceptedAt: true },
                orderBy: { acceptedAt: "desc" },
                take: Math.max(poolIds.length * 100, 500),
            }),
            getInOfficeEmployeeIds(employeeIds),
        ]);

        const countsByBroker = new Map<string, Map<string, number>>();
        for (const row of statusCounts) {
            if (!row.assignedBrokerId) continue;
            if (!countsByBroker.has(row.assignedBrokerId)) {
                countsByBroker.set(row.assignedBrokerId, new Map());
            }
            countsByBroker.get(row.assignedBrokerId)!.set(row.status, row._count._all);
        }

        const responseByBroker = new Map<string, number[]>();
        for (const row of acceptedRows) {
            if (!row.assignedBrokerId || !row.assignedAt || !row.acceptedAt) continue;
            const ms = row.acceptedAt.getTime() - row.assignedAt.getTime();
            if (ms < 0) continue;
            if (!responseByBroker.has(row.assignedBrokerId)) {
                responseByBroker.set(row.assignedBrokerId, []);
            }
            const diffs = responseByBroker.get(row.assignedBrokerId)!;
            if (diffs.length < 100) diffs.push(ms);
        }

        const result: Array<{
            brokerId: string;
            name: string;
            username: string;
            role: string;
            status: string;
            online: boolean;
            active: boolean;
            availableForAssignment: boolean;
            inOffice: boolean;
            employeeId: string | null;
            teamLeadId: string | null;
            teamLeadName: string | null;
            currentShipments: number;
            awaitingAcceptance: number;
            followUp: number;
            quotesSent: number;
            won: number;
            lost: number;
            averageResponseTimeMinutes: number | null;
        }> = [];

        for (const b of pool) {
            const statusMap = countsByBroker.get(b.userId);
            const countFor = (status: string) => statusMap?.get(status) || 0;
            const currentShipments = ACTIVE_STATUSES.reduce(
                (sum, status) => sum + countFor(status),
                0
            );
            const diffs = responseByBroker.get(b.userId) || [];
            const avgMs = diffs.length
                ? diffs.reduce((a, c) => a + c, 0) / diffs.length
                : null;
            const inOffice = Boolean(b.employeeId && inOfficeIds.has(b.employeeId));
            const tl = b.teamLead;

            result.push({
                brokerId: b.userId,
                name: brokerName(b),
                username: b.username,
                role: b.role.roleName,
                status: b.isActive ? "Active" : "Inactive",
                online: b.isActive,
                active: b.isActive,
                availableForAssignment: b.availableForAssignment,
                inOffice,
                employeeId: b.employeeId,
                teamLeadId: b.teamLeadId || null,
                teamLeadName: tl ? brokerName(tl) : null,
                currentShipments,
                awaitingAcceptance: countFor("AWAITING_ACCEPTANCE"),
                followUp: countFor("FOLLOW_UP"),
                quotesSent: countFor("QUOTE_SENT"),
                won: countFor("WON"),
                lost: countFor("LOST") + countFor("ACCEPTED_ANOTHER_COMPANY"),
                averageResponseTimeMinutes: avgMs == null ? null : Math.round(avgMs / 60000),
            });
        }
        return result.sort((a, b) => b.currentShipments - a.currentShipments);
    }

    async getBrokerWorkspace(brokerId: string) {
        const user = await prisma.user.findUnique({
            where: { userId: brokerId },
            include: {
                role: true,
                teamLead: { select: { userId: true, firstName: true, lastName: true, username: true } },
            },
        });
        if (!user) return null;

        const stats = (await this.getBrokerWorkload()).find((b) => b.brokerId === brokerId);
        const shipments = await this.listShipments({ brokerId, limit: 200 });

        return {
            broker: {
                brokerId: user.userId,
                name: brokerName(user),
                username: user.username,
                role: user.role.roleName,
                online: user.isActive,
                teamLeadId: user.teamLeadId || null,
                teamLeadName: user.teamLead ? brokerName(user.teamLead) : null,
            },
            stats: stats || {
                currentShipments: 0,
                awaitingAcceptance: 0,
                followUp: 0,
                quotesSent: 0,
                won: 0,
                lost: 0,
            },
            shipments,
        };
    }

    async updateShipmentStatus(
        shipmentLeadId: string,
        status: string,
        actorUserId?: string,
        extras?: { notes?: string; price?: number; priority?: string; loadNumber?: string }
    ) {
        const normalized = String(status || "").toUpperCase().trim();
        const current = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId },
            select: { status: true },
        });
        if (!current) {
            throw Object.assign(new Error("Shipment not found"), { status: 404 });
        }
        // Notes / extras with the same auto status are fine; changing INTO an auto status is not.
        if (
            (AUTO_PIPELINE_STATUSES as readonly string[]).includes(normalized) &&
            String(current.status).toUpperCase() !== normalized
        ) {
            throw Object.assign(
                new Error(
                    `${normalized.replace(/_/g, " ")} updates automatically from uShip / broker Gmail — pick a manual status instead`
                ),
                { status: 422 }
            );
        }
        await shipmentService.transitionStatus({
            shipmentLeadId,
            status,
            actorUserId,
            extras,
            // Manual CRM saves may jump stages; Event Engine still records the change.
            skipLifecycleCheck: true,
        });
        return this.getShipmentCard(shipmentLeadId);
    }

    /** Explicit "Open in uShip" click — always set AGENT_OPEN from waiting states. */
    async markAgentOpened(shipmentLeadId: string, actorUserId: string) {
        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId },
            select: { assignedBrokerId: true, status: true, assignedAt: true, acceptanceDeadline: true },
        });
        if (!lead) return null;

        const role = await actorRoleName(actorUserId);
        const current = normalizeStatus(lead.status);
        const alreadyPastOpen = new Set([
            "AGENT_OPEN",
            "WORKING",
            "BID_SUBMITTED",
            "CUSTOMER_REPLIED",
            "ACCEPT_GREEN",
            "ACCEPTED_ANOTHER_COMPANY",
            "DELETED_FROM_CUSTOMER",
            "LOST",
            "CLOSED",
            "COMPLETED",
        ]);

        if (current !== "AGENT_OPEN" && !alreadyPastOpen.has(current) && !isLoadPhase(current)) {
            const deadline =
                lead.acceptanceDeadline ||
                (lead.assignedAt
                    ? new Date(lead.assignedAt.getTime() + 15 * 60_000)
                    : new Date(Date.now() + 15 * 60_000));
            await prisma.shipmentLead.update({
                where: { shipmentLeadId },
                data: {
                    status: "AGENT_OPEN",
                    acceptanceDeadline: deadline,
                },
            });
            await domainEventEngine.emit({
                shipmentLeadId,
                eventType: "AGENT_OPENED",
                title: "Open in uShip",
                message: `Status → Open in uShip${role ? ` — ${role}` : ""}`,
                actorUserId,
                timelineStage: "AGENT_OPENED",
                payload: { status: "AGENT_OPEN", actorRole: role, source: "uship_link" },
            });
        }

        return this.getShipmentCard(shipmentLeadId);
    }

    /**
     * Broker marks Answer/Question to the customer (green traffic-light click).
     * Replaces any previous Broker Answer on this card — only the latest is kept.
     */
    async markBrokerQuestion(shipmentLeadId: string, actorUserId: string, note?: string) {
        const lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!lead) {
            throw Object.assign(new Error("Shipment not found"), { status: 404 });
        }
        if (lead.assignedBrokerId && lead.assignedBrokerId !== actorUserId) {
            const user = await prisma.user.findUnique({
                where: { userId: actorUserId },
                select: { role: { select: { roleName: true } } },
            });
            const role = user?.role?.roleName || "";
            if (!["Administrator", "Owner", "Manager", "Team Lead"].includes(role)) {
                throw Object.assign(new Error("Only the assigned broker can mark Broker Answer"), {
                    status: 403,
                });
            }
        }

        const event = await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "BROKER_QUESTION",
            title: "Broker Answer",
            message:
                note?.trim() ||
                "Broker answered / asked the customer (waiting for Customer Respond)",
            actorUserId,
            payload: { source: "manual_traffic_light", label: "Broker Answer" },
            timelineStage: "BROKER_QUESTION",
        });

        await domainEventEngine.pruneOlderQa(shipmentLeadId, "broker", event.eventId);
        // Display filters to the latest trusted items — do not delete Q&A history.
        await domainEventEngine.correspondenceForDisplay(shipmentLeadId);

        try {
            const { clearBrokerReplyDeadline } = await import(
                "./broker-response-problem.service.js"
            );
            await clearBrokerReplyDeadline(shipmentLeadId);
        } catch {
            /* ignore */
        }

        if (
            ["WORKING", "BID_SUBMITTED", "AGENT_OPEN", "FOLLOW_UP"].includes(lead.status) ||
            lead.status === "CUSTOMER_REPLIED"
        ) {
            await prisma.shipmentLead.update({
                where: { shipmentLeadId },
                data: { status: "FOLLOW_UP" },
            }).catch(() => null);
        }

        return this.getShipmentCard(shipmentLeadId);
    }

    /**
     * TEST ONLY — simulate uShip "Customer Accepted" email without Gmail.
     * Sets ACCEPTED, emits CUSTOMER_ACCEPTED, auto-creates Load (GL…).
     * Allowed for Owner/Admin/Manager always; Broker only on own assigned card
     * when ALLOW_TEST_CUSTOMER_ACCEPT is not "0"/"false".
     */
    async simulateCustomerAccepted(shipmentLeadId: string, actorUserId: string) {
        const allowEnv = String(process.env.ALLOW_TEST_CUSTOMER_ACCEPT || "1").toLowerCase();
        const testEnabled = !["0", "false", "no", "off"].includes(allowEnv);

        const lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!lead) {
            throw Object.assign(new Error("Shipment not found"), { status: 404 });
        }

        const user = await prisma.user.findUnique({
            where: { userId: actorUserId },
            select: { role: { select: { roleName: true } } },
        });
        const role = user?.role?.roleName || "";
        const isOps = ["Administrator", "Owner", "Manager", "Team Lead"].includes(role);
        const isAssignedBroker = lead.assignedBrokerId === actorUserId;

        if (!isOps) {
            if (!testEnabled) {
                throw Object.assign(
                    new Error("Test Customer Accept is disabled (ALLOW_TEST_CUSTOMER_ACCEPT=0)"),
                    { status: 403 }
                );
            }
            if (!isAssignedBroker) {
                throw Object.assign(
                    new Error("Only the assigned broker (or Owner) can run Test Customer Accept"),
                    { status: 403 }
                );
            }
        }

        if (["CLOSED", "LOST", "ACCEPTED_ANOTHER_COMPANY", "DELETED_FROM_CUSTOMER"].includes(normalizeStatus(lead.status))) {
            throw Object.assign(
                new Error(`Cannot simulate Customer Accepted from status ${lead.status}`),
                { status: 422 }
            );
        }

        await ensureGreenOsShipmentId(shipmentLeadId).catch(() => null);

        // Mirror uShip Accepted email: ACCEPTED auto-creates Load (GL…) inside transitionStatus.
        if (normalizeStatus(lead.status) !== "ACCEPT_GREEN" && !isLoadPhase(lead.status)) {
            await shipmentService.transitionStatus({
                shipmentLeadId,
                status: "ACCEPT_GREEN",
                actorUserId,
                skipLifecycleCheck: true,
            });
        } else {
            await shipmentService.createLoadAfterAccepted({
                shipmentLeadId,
                actorUserId,
            });
        }

        return this.getShipmentCard(shipmentLeadId);
    }

    async acceptShipment(shipmentLeadId: string, actorUserId: string) {
        const lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!lead) return null;
        if (lead.assignedBrokerId && lead.assignedBrokerId !== actorUserId) {
            const role = await actorRoleName(actorUserId);
            if (!canWorkAnyShipment(role)) {
                throw Object.assign(
                    new Error("Only the assigned broker (or Owner/Manager) can accept this shipment"),
                    { status: 403 }
                );
            }
        }
        if (lead.status === "WORKING" && lead.acceptedAt) {
            return this.getShipmentCard(shipmentLeadId);
        }
        if (
            lead.status !== "ASSIGNED" &&
            lead.status !== "AWAITING_ACCEPTANCE" &&
            lead.status !== "AGENT_OPEN"
        ) {
            throw Object.assign(
                new Error(`Cannot accept shipment in status ${lead.status}`),
                { status: 422 }
            );
        }

        await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                status: "WORKING",
                acceptedAt: new Date(),
                acceptanceDeadline: null,
                assignedBrokerId: lead.assignedBrokerId || actorUserId,
            },
        });
        await ensureGreenOsShipmentId(shipmentLeadId).catch(() => null);
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "BROKER_ACCEPTED_WORK",
            title: "Shipment Accepted",
            message: "Broker accepted shipment — working the load",
            actorUserId,
            timelineStage: "BROKER_ACCEPTED_WORK",
            payload: { status: "WORKING" },
        });
        return this.getShipmentCard(shipmentLeadId);
    }
}

export const crmService = new CrmService();
