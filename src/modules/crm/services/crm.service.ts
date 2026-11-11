import { prisma } from "../../../config/database.js";
import { config } from "../../../config/env.js";
import { carrierMissingOnPickup } from "../../shipment/carrier-missing-on-pickup.js";
import { getInOfficeEmployeeIds } from "../../../services/attendance-presence.service.js";
import { ACTIVE_STATUSES } from "../crm.constants.js";
import {
    AUTO_PIPELINE_STATUSES,
    compareShipmentsForBoard,
} from "../../shipment/shipment.constants.js";
import { domainEventEngine } from "../../shipment/services/domain-event.engine.js";
import { shipmentService } from "../../shipment/services/shipment.service.js";
import { ensureGreenOsShipmentId } from "../../shipment/shipment.id.js";
import { isLoadPhase, normalizeStatus, statusLabel } from "../../shipment/shipment.lifecycle.js";
import { listTeamBrokerIds } from "../../../auth/team-scope.js";
import { awaitingAcceptWhere, unassignedShipmentWhere } from "../unassigned-where.js";
import {
    applyStatusGroupFilter,
    canonicalStatusGroup,
    shipmentStatusFilter,
    statusFiltersForClient,
    statusGroupIncludesDeleted,
} from "../shipment-status-filter.js";
import { generatedLoadWhere, isGeneratedLoad, notGeneratedLoadWhere } from "../shipment-tabs.js";
import { brokerArrivalSummary, latestHandoffs } from "../broker-arrival-summary.js";
import { canWorkAnyShipment } from "../../../auth/roles.js";
import {
    followUshipToListingUrl,
    hasRealListingSlug,
    isUshipListingId,
    isUshipTrackingOrJunkUrl,
    listingIdFromText,
    trackingUrlsFromText,
    ushipListingUrlFromLead,
    ushipOpenUrlFromLead,
} from "../../email/parsers/uship/listing-url.js";
import { gmailListener } from "../../email/gmail/gmail.listener.js";
import { brokerGmailSyncService } from "../../email/gmail/broker-gmail-sync.service.js";
import {
    ASSIGNMENT_TIMEZONE,
    arrivedSince,
    chooseAssignmentPool,
    isAfterHoursAssignment,
    startOfShipmentDay,
} from "../../../utils/helpers.js";

async function actorRoleName(userId: string): Promise<string> {
    const user = await prisma.user.findUnique({
        where: { userId },
        select: { role: { select: { roleName: true } } },
    });
    return user?.role?.roleName || "";
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
        // Prefer concrete /shipment|/listing URL; Instant Alert CTA tracker otherwise
        // so Open in uShip works when Cloudflare blocks server-side follow.
        ushipUrl: ushipOpenUrlFromLead(lead),
        brokerReplyDeadline: lead.brokerReplyDeadline || null,
        customerReplied: String(lead.status || "") === "CUSTOMER_REPLIED",
        carrierMissingOnPickup: carrierMissingOnPickup({
            loadNumber: lead.loadNumber as string | null,
            carrierName: lead.carrierName as string | null,
            status: lead.status as string | null,
            pickupFrom: lead.pickupFrom as Date | null,
            opsPickupAt: lead.opsPickupAt as Date | null,
            timeZone: config.timezone,
        }),
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
    externalShipmentId: true,
    imageUrl: true,
    priority: true,
    status: true,
    loadNumber: true,
    carrierName: true,
    pickupFrom: true,
    opsPickupAt: true,
    viewUrl: true,
    assignedBrokerId: true,
    assignedAt: true,
    isReassignment: true,
    wasEverReassigned: true,
    brokerReplyDeadline: true,
    quoteSentAt: true,
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
        brokerName: e.brokerName,
        assignedBrokerId: (lead.assignedBrokerId as string | null) || null,
        miles: (lead.miles as number | null) ?? null,
        price: (lead.price as number | null) ?? null,
        isReassignment: Boolean(lead.isReassignment || lead.wasEverReassigned),
        wasEverReassigned: Boolean(lead.wasEverReassigned || lead.isReassignment),
        carrierMissingOnPickup: carrierMissingOnPickup({
            loadNumber: lead.loadNumber as string | null,
            carrierName: lead.carrierName as string | null,
            status: lead.status as string | null,
            pickupFrom: lead.pickupFrom as Date | null,
            opsPickupAt: lead.opsPickupAt as Date | null,
            timeZone: config.timezone,
        }),
        brokerReplyDeadline: lead.brokerReplyDeadline as Date | string | null,
        customerReplied: Boolean(e.customerReplied),
        competitorQuotes: Number(lead.competitorQuotes || 0),
        competitorQuoteAt: (lead.competitorQuoteAt as Date | string | null) || null,
        bidSubmitted: Boolean(lead.bidSubmitted),
        bidSubmittedAt: (lead.bidSubmittedAt as Date | string | null) || null,
        quoteDeclined: Boolean(lead.quoteDeclined),
        quoteDeclinedAt: (lead.quoteDeclinedAt as Date | string | null) || null,
        updatedAt: lead.updatedAt as Date | string | null,
        assignedAt: (lead.assignedAt as Date | string | null) || null,
    };
}

const HANDOFF_HIDDEN = [
    "DELETED_FROM_CUSTOMER",
    "LOST",
    "ACCEPTED_ANOTHER_COMPANY",
    "NO_LONGER_NEEDED",
    "ROUND_DECLINED",
    "VOIDED",
];

/** Soft caps so New/Other boards stay responsive as assignment history grows. */
const HANDOFF_LOG_CAP = 2000;
const HANDOFF_FLAGGED_CAP = 1500;

/**
 * Owner and team boards. New is each first give (ASSIGNED).
 * Other is each pass (REASSIGNED). The same shipment can be in both,
 * once for the person who received it as New and once for who received it as Other.
 *
 * Performance: scan capped logs + light lead meta, paginate, then hydrate only
 * the current page of full list columns (never every matching row).
 */
async function listHandoffBoard(options: {
    assignmentKind: "new" | "other";
    teamLeadId?: string;
    statusGroup?: string;
    page?: number;
    pageSize?: number;
    limit?: number;
    lite?: boolean;
}) {
    const eventType = options.assignmentKind === "other" ? "REASSIGNED" : "ASSIGNED";
    const teamIds = options.teamLeadId ? await listTeamBrokerIds(options.teamLeadId) : null;
    const [logs, flagged] = await Promise.all([
        prisma.assignmentLog.findMany({
            where: {
                eventType,
                shipmentLeadId: { not: null },
                assignedUserId: teamIds
                    ? { in: teamIds.length ? teamIds : ["__none__"] }
                    : { not: null },
            },
            orderBy: { createdAt: "desc" },
            select: { shipmentLeadId: true, assignedUserId: true, createdAt: true },
            take: HANDOFF_LOG_CAP,
        }),
        prisma.shipmentLead.findMany({
            where: {
                ...(options.assignmentKind === "new"
                    ? { isReassignment: false, wasEverReassigned: false }
                    : { OR: [{ isReassignment: true }, { wasEverReassigned: true }] }),
                status: { notIn: HANDOFF_HIDDEN },
                ...(teamIds
                    ? { assignedBrokerId: { in: teamIds.length ? teamIds : ["__none__"] } }
                    : {}),
                AND: [notGeneratedLoadWhere()],
            },
            orderBy: { updatedAt: "desc" },
            take: HANDOFF_FLAGGED_CAP,
            select: {
                shipmentLeadId: true,
                assignedBrokerId: true,
                assignedAt: true,
                receivedAt: true,
                createdAt: true,
                status: true,
                loadNumber: true,
            },
        }),
    ]);
    const handoffs = latestHandoffs(
        logs.map((log) => ({
            shipmentId: log.shipmentLeadId || "",
            brokerId: log.assignedUserId || "",
            at: log.createdAt,
        }))
    );
    const known = new Set(handoffs.map((row) => `${row.shipmentId}\0${row.brokerId}`));
    const metaById = new Map(
        flagged.map((lead) => [
            lead.shipmentLeadId,
            { status: String(lead.status || ""), loadNumber: lead.loadNumber as string | null },
        ])
    );
    for (const lead of flagged) {
        const brokerId = String(lead.assignedBrokerId || "");
        if (!brokerId) continue;
        const key = `${lead.shipmentLeadId}\0${brokerId}`;
        if (known.has(key)) continue;
        known.add(key);
        handoffs.push({
            shipmentId: lead.shipmentLeadId,
            brokerId,
            at: lead.assignedAt || lead.receivedAt || lead.createdAt,
        });
    }
    handoffs.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    const missingMetaIds = [
        ...new Set(
            handoffs
                .map((row) => row.shipmentId)
                .filter((id) => id && !metaById.has(id))
        ),
    ];
    if (missingMetaIds.length) {
        // Chunk IN lists — SQLite/Postgres stay happy with thousands of ids.
        const chunkSize = 400;
        for (let i = 0; i < missingMetaIds.length; i += chunkSize) {
            const chunk = missingMetaIds.slice(i, i + chunkSize);
            const metaRows = await prisma.shipmentLead.findMany({
                where: { shipmentLeadId: { in: chunk } },
                select: { shipmentLeadId: true, status: true, loadNumber: true },
            });
            for (const lead of metaRows) {
                metaById.set(lead.shipmentLeadId, {
                    status: String(lead.status || ""),
                    loadNumber: lead.loadNumber as string | null,
                });
            }
        }
    }

    const allowed = shipmentStatusFilter(options.statusGroup);
    const matched = handoffs.filter((row) => {
        const meta = metaById.get(row.shipmentId);
        if (!meta) return false;
        if (HANDOFF_HIDDEN.includes(meta.status)) return false;
        if (isGeneratedLoad(meta)) return false;
        if (allowed && !allowed.includes(meta.status)) return false;
        return true;
    });

    const pageSizeRaw = options.pageSize ?? options.limit ?? 50;
    const pageSize = Math.min(200, Math.max(1, Number(pageSizeRaw) || 50));
    const page = Math.max(1, Number(options.page) || 1);
    const skip = (page - 1) * pageSize;
    const total = matched.length;
    const slice = matched.slice(skip, skip + pageSize);
    const pageIds = [...new Set(slice.map((row) => row.shipmentId))];
    const pageLeads = pageIds.length
        ? await prisma.shipmentLead.findMany({
              where: { shipmentLeadId: { in: pageIds } },
              select: SHIPMENT_LIST_SELECT,
          })
        : [];
    const byId = new Map(pageLeads.map((lead) => [lead.shipmentLeadId, lead]));
    const brokers = await userMap(matched.map((row) => row.brokerId));
    const lite = options.lite === true;
    const items = slice.map((row) => {
        const lead = byId.get(row.shipmentId);
        if (!lead) {
            return lite
                ? {
                      shipmentLeadId: row.shipmentId,
                      greenOsShipmentId: null,
                      shipmentTitle: "Shipment",
                      customer: "—",
                      pickup: "—",
                      delivery: "—",
                      status: metaById.get(row.shipmentId)?.status || "",
                      statusLabel: statusLabel(metaById.get(row.shipmentId)?.status || ""),
                      brokerName: brokerName(brokers.get(row.brokerId)),
                      assignedBrokerId: row.brokerId,
                      assignedAt: row.at,
                  }
                : enrichLead(
                      {
                          shipmentLeadId: row.shipmentId,
                          status: metaById.get(row.shipmentId)?.status || "",
                          assignedBrokerId: row.brokerId,
                          assignedAt: row.at,
                      },
                      brokers
                  );
        }
        const withHandoff = {
            ...lead,
            assignedBrokerId: row.brokerId,
            assignedAt: row.at,
        } as Record<string, unknown>;
        return lite ? toBrokerListRow(withHandoff, brokers) : enrichLead(withHandoff, brokers);
    });
    const statusGroup = canonicalStatusGroup(options.statusGroup);
    return {
        items,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        statusGroup,
        statusFilters: statusFiltersForClient(),
        brokerSummary: brokerArrivalSummary(
            matched.map((row) => ({ brokerId: row.brokerId, at: row.at })),
            (brokerId) => brokerName(brokerId ? brokers.get(brokerId) : undefined)
        ),
    };
}

export class CrmService {
    async getDashboard(options?: { teamLeadId?: string; shell?: boolean }) {
        // Shipment "today" starts at 01:00 Yerevan — same clock as After 01:00 mode.
        const todayStart = startOfShipmentDay();
        const arrivedToday = arrivedSince(todayStart);
        const teamBrokerIds = options?.teamLeadId
            ? await listTeamBrokerIds(options.teamLeadId)
            : null;
        const teamAssigned =
            teamBrokerIds != null
                ? { assignedBrokerId: { in: teamBrokerIds } }
                : {};
        const { assignmentEngine } = await import("../../assignment/assignment.engine.js");
        const { eligible, mode: liveAssignmentMode } =
            await assignmentEngine.resolveEligibleBrokers();
        const eligibleIds = eligible.map((broker) => broker.userId);
        const unassignedWhere = unassignedShipmentWhere(eligibleIds, teamBrokerIds);
        const awaitingWhere = {
            AND: [
                awaitingAcceptWhere(
                    teamBrokerIds
                        ? eligibleIds.filter((id) => teamBrokerIds.includes(id))
                        : eligibleIds
                ),
                ...(teamBrokerIds ? [teamAssigned] : []),
            ],
        };

        const shell = options?.shell === true;

        const countQueries = Promise.all([
            prisma.shipmentLead.count({
                where: {
                    AND: [
                        arrivedToday,
                        ...(teamBrokerIds
                            ? [
                                  {
                                      OR: [
                                          { assignedBrokerId: { in: teamBrokerIds } },
                                          unassignedWhere,
                                      ],
                                  },
                              ]
                            : []),
                    ],
                },
            }),
            prisma.shipmentLead.count({ where: unassignedWhere }),
            prisma.shipmentLead.count({
                where: awaitingWhere,
            }),
            prisma.shipmentLead.count({
                where: { status: "WORKING", ...teamAssigned },
            }),
            prisma.shipmentLead.count({
                where: {
                    ...teamAssigned,
                    OR: [
                        { quoteSentAt: { gte: todayStart } },
                        {
                            status: { in: ["BID_SUBMITTED", "QUOTE_SENT"] },
                            updatedAt: { gte: todayStart },
                        },
                    ],
                },
            }),
            prisma.shipmentLead.count({
                where: {
                    status: "WON",
                    updatedAt: { gte: todayStart },
                    ...teamAssigned,
                },
            }),
            prisma.shipmentLead.count({
                where: {
                    status: { in: ["LOST", "ACCEPTED_ANOTHER_COMPANY"] },
                    updatedAt: { gte: todayStart },
                    ...teamAssigned,
                },
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
                    select: SHIPMENT_LIST_SELECT,
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
            // Dashboard only needs active counts + in-office — skip bid/response scans.
            this.getBrokerWorkload({
                ...(options?.teamLeadId ? { teamLeadId: options.teamLeadId } : {}),
                summary: true,
            }),
            prisma.shipmentLead.findMany({
                where: unassignedWhere,
                orderBy: { createdAt: "asc" },
                take: 50,
                select: SHIPMENT_LIST_SELECT,
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
                select: SHIPMENT_LIST_SELECT,
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
            .filter((b) => b.role === "Broker" || b.role === "Team Lead")
            .reduce((sum, b) => sum + (b.currentShipments || 0), 0);
        // Prefer the live queue mode (After 01:00 / In Office / waiting).
        const assignmentMode = liveAssignmentMode;
        // In Office hours: loads with checked-in brokers. After 01:00: loads on the night queue.
        const ownerActiveLoads =
            assignmentMode === "after_hours"
                ? shipmentsToAllAssignedBrokers
                : assignmentMode === "in_office"
                  ? shipmentsToPresentBrokers
                  : 0;

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
        page?: number;
        pageSize?: number;
        teamLeadId?: string;
        /** Broker My Shipments — slim payload, no heavy blobs. */
        lite?: boolean;
        /** new | other | accepted | loads — board tabs. */
        assignmentKind?: "new" | "other" | "accepted" | "loads";
        /** Dropdown on the shipment list. Intersects the tab; unknown values are ignored. */
        statusGroup?: string;
        /** Include terminal deleted rows (default: hide — they are purged from CRM). */
        includeDeleted?: boolean;
        /** Return total only — used by tab badge probes. */
        countOnly?: boolean;
        /** Skip wasEverReassigned repair (caller already ran it). */
        skipRepair?: boolean;
    }) {
        if ((options?.lite || options?.assignmentKind) && !options?.skipRepair && !options?.countOnly) {
            try {
                const { assignmentEngine } = await import(
                    "../../assignment/assignment.engine.js"
                );
                await assignmentEngine.repairPassedShipmentFlags();
            } catch {
                /* listing still works if repair is busy */
            }
        }

        if (
            (options?.assignmentKind === "new" || options?.assignmentKind === "other") &&
            !options?.brokerId
        ) {
            return listHandoffBoard({
                assignmentKind: options.assignmentKind,
                teamLeadId: options.teamLeadId,
                statusGroup: options.statusGroup,
                page: options.page,
                pageSize: options.pageSize,
                limit: options.limit,
                lite: options.lite === true,
            });
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
        const statusGroup = canonicalStatusGroup(options?.statusGroup);
        if (options?.status) {
            where.status = options.status;
        } else if (!options?.includeDeleted && !statusGroupIncludesDeleted(statusGroup)) {
            // Deleted-by-customer cards are purged; hide any leftover soft-deleted rows.
            where.status = { not: "DELETED_FROM_CUSTOMER" };
        }

        /** Waiting for broker Accept — stay in New / Other. */
        const waitingStatuses = [
            "NEW",
            "UNASSIGNED",
            "ASSIGNED",
            "AWAITING_ACCEPTANCE",
            "AGENT_OPEN",
        ];
        const excludeTerminal = [
            "ACCEPTED_ANOTHER_COMPANY",
            "DELETED_FROM_CUSTOMER",
            "NO_LONGER_NEEDED",
            "ROUND_DECLINED",
        ];

        if (options?.assignmentKind === "new") {
            where.isReassignment = false;
            where.wasEverReassigned = false;
            if (options.brokerId) {
                // Broker's own queue: only loads still waiting for their Accept.
                where.AND = [
                    ...(Array.isArray(where.AND) ? where.AND : []),
                    { status: { in: waitingStatuses } },
                    notGeneratedLoadWhere(),
                ];
            } else {
                // Main account: every new shipment that arrived, including ones a broker already took.
                where.AND = [
                    ...(Array.isArray(where.AND) ? where.AND : []),
                    {
                        status: {
                            notIn: [
                                "DELETED_FROM_CUSTOMER",
                                "LOST",
                                "ACCEPTED_ANOTHER_COMPANY",
                                "NO_LONGER_NEEDED",
                                "ROUND_DECLINED",
                            ],
                        },
                    },
                    notGeneratedLoadWhere(),
                ];
            }
            delete where.status;
        } else if (options?.assignmentKind === "other") {
            const passed = {
                OR: [{ isReassignment: true }, { wasEverReassigned: true }],
            };
            // Passed on because a broker did not take it — still not accepted.
            // A generated Load never belongs here, including a direct-customer Load.
            where.AND = [
                ...(Array.isArray(where.AND) ? where.AND : []),
                passed,
                { status: { in: waitingStatuses } },
                notGeneratedLoadWhere(),
            ];
            delete where.status;
        } else if (options?.assignmentKind === "accepted") {
            // Broker accepted (Shipment Accepted) or progressed further — leave New/Other.
            // Generated loads have their own tab.
            where.AND = [
                ...(Array.isArray(where.AND) ? where.AND : []),
                { status: { notIn: [...waitingStatuses, ...excludeTerminal] } },
                notGeneratedLoadWhere(),
            ];
            delete where.status;
        } else if (options?.assignmentKind === "loads") {
            where.AND = [
                ...(Array.isArray(where.AND) ? where.AND : []),
                generatedLoadWhere(),
            ];
            delete where.status;
        }

        // After the tab filter. New / Other / Accepted delete where.status,
        // so the dropdown has to be a separate AND or it would be wiped.
        applyStatusGroupFilter(where, statusGroup);

        const lite = options?.lite === true;
        const pageSizeRaw = options?.pageSize ?? options?.limit ?? (lite ? 50 : 50);
        const pageSize = Math.min(200, Math.max(1, Number(pageSizeRaw) || 50));
        const page = Math.max(1, Number(options?.page) || 1);
        const skip = (page - 1) * pageSize;
        const emptyPage = {
            items: [] as Array<Record<string, unknown>>,
            total: 0,
            page,
            pageSize,
            totalPages: 1,
            statusGroup,
            statusFilters: statusFiltersForClient(),
        };

        // Badge probes only need totals — never hydrate rows or flag events.
        if (options?.countOnly) {
            const total = await prisma.shipmentLead.count({ where });
            return { ...emptyPage, total, totalPages: Math.max(1, Math.ceil(total / Math.max(1, pageSize))) };
        }

        // Broker My Shipments: priority board order must apply across pages
        // (Waiting → BROKER REPLY / Bid Submitted → Shipment Accepted), not only
        // within the current page after a client-side re-sort.
        const priorityBoard = Boolean(options?.brokerId || lite || options?.assignmentKind);
        let total: number;
        let rows: Array<Record<string, unknown>>;
        if (priorityBoard) {
            // Sort keys only — full list columns load for the current page.
            const sortKeys = await prisma.shipmentLead.findMany({
                where,
                select: { shipmentLeadId: true, status: true, updatedAt: true },
            });
            sortKeys.sort(compareShipmentsForBoard);
            total = sortKeys.length;
            const pageIds = sortKeys.slice(skip, skip + pageSize).map((row) => row.shipmentLeadId);
            if (!pageIds.length) {
                rows = [];
            } else {
                const pageRows = await prisma.shipmentLead.findMany({
                    where: { shipmentLeadId: { in: pageIds } },
                    select: SHIPMENT_LIST_SELECT,
                });
                const byId = new Map(pageRows.map((row) => [row.shipmentLeadId, row]));
                rows = pageIds
                    .map((id) => byId.get(id))
                    .filter(Boolean) as Array<Record<string, unknown>>;
            }
        } else {
            const [count, pageRows] = await Promise.all([
                prisma.shipmentLead.count({ where }),
                prisma.shipmentLead.findMany({
                    where,
                    orderBy: { updatedAt: "desc" },
                    skip,
                    take: pageSize,
                    select: SHIPMENT_LIST_SELECT,
                }),
            ]);
            total = count;
            rows = pageRows as Array<Record<string, unknown>>;
        }
        const brokers = await userMap(rows.map((r) => (r.assignedBrokerId as string) || ""));
        const ids = rows.map((r) => String(r.shipmentLeadId || "")).filter(Boolean);
        const flagEvents = ids.length
            ? await prisma.domainEvent.findMany({
                  where: {
                      shipmentLeadId: { in: ids },
                      eventType: {
                          in: [
                              "BID_SUBMITTED",
                              "COMPETITOR_QUOTE",
                              "QUOTE_DECLINED",
                              "SHIPMENT_ACCEPTED_ANOTHER_COMPANY",
                          ],
                      },
                  },
                  select: { shipmentLeadId: true, eventType: true, createdAt: true },
              })
            : [];
        const flags = new Map<
            string,
            {
                competitorQuotes: number;
                competitorQuoteAt: Date | null;
                bidAt: Date | null;
                declinedAt: Date | null;
            }
        >();
        for (const event of flagEvents) {
            const id = event.shipmentLeadId;
            if (!id) continue;
            const row = flags.get(id) || {
                competitorQuotes: 0,
                competitorQuoteAt: null,
                bidAt: null,
                declinedAt: null,
            };
            if (event.eventType === "COMPETITOR_QUOTE") {
                row.competitorQuotes += 1;
                if (!row.competitorQuoteAt || event.createdAt > row.competitorQuoteAt) {
                    row.competitorQuoteAt = event.createdAt;
                }
            } else if (event.eventType === "BID_SUBMITTED") {
                if (!row.bidAt || event.createdAt > row.bidAt) row.bidAt = event.createdAt;
            } else if (!row.declinedAt || event.createdAt > row.declinedAt) {
                row.declinedAt = event.createdAt;
            }
            flags.set(id, row);
        }
        const bidStatuses = new Set(["BID_SUBMITTED", "QUOTE_SENT"]);
        const items = rows.map((r) => {
            const id = String(r.shipmentLeadId || "");
            const flag = flags.get(id);
            const quoteSentAt = (r.quoteSentAt as Date | null) || null;
            const status = String(r.status || "");
            const withFlags = {
                ...r,
                competitorQuotes: flag?.competitorQuotes || 0,
                competitorQuoteAt: flag?.competitorQuoteAt || null,
                bidSubmitted: Boolean(quoteSentAt || flag?.bidAt || bidStatuses.has(status)),
                bidSubmittedAt: flag?.bidAt || quoteSentAt,
                quoteDeclined: Boolean(
                    flag?.declinedAt || status === "ACCEPTED_ANOTHER_COMPANY"
                ),
                quoteDeclinedAt: flag?.declinedAt || null,
            };
            return lite
                ? toBrokerListRow(withFlags, brokers)
                : enrichLead(withFlags, brokers);
        });
        return {
            items,
            total,
            page,
            pageSize,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            statusGroup,
            statusFilters: statusFiltersForClient(),
        };
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
                        bodyText: true,
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

        const extraBlobs = [
            lead.emailMessage?.subject,
            lead.emailMessage?.snippet,
            lead.emailMessage?.bodyText,
            lead.emailMessage?.bodyHtml,
            lead.documentsJson,
            ...mailboxEmails.map((m) => m.subject),
            ...mailboxEmails.map((m) => m.snippet),
            ...mailboxEmails.map((m) => m.bodyText),
            ...lead.importLogs.map((log) => log.message),
            ...lead.domainEvents.map((ev) => ev.message),
            ...lead.domainEvents.map((ev) => ev.payloadJson),
            ...correspondence.map((item) => item.message),
            ...correspondence.map((item) => item.title),
        ];
        const resolvedUshipUrl = ushipListingUrlFromLead(
            lead as unknown as Record<string, unknown>,
            extraBlobs
        );
        const openUshipUrl =
            (resolvedUshipUrl && hasRealListingSlug(resolvedUshipUrl)
                ? resolvedUshipUrl
                : null) ||
            ushipOpenUrlFromLead(lead as unknown as Record<string, unknown>, extraBlobs);
        if (resolvedUshipUrl && hasRealListingSlug(resolvedUshipUrl)) {
            const listingId = listingIdFromText(resolvedUshipUrl);
            const currentView = String(lead.viewUrl || "");
            const shouldFixView =
                !currentView ||
                isUshipTrackingOrJunkUrl(currentView) ||
                (listingId &&
                    !currentView.includes(`/listing/${listingId}`) &&
                    !currentView.includes(`/${listingId}`));
            if (shouldFixView || (listingId && !lead.externalShipmentId)) {
                await prisma.shipmentLead
                    .update({
                        where: { shipmentLeadId: lead.shipmentLeadId },
                        data: {
                            ...(shouldFixView ? { viewUrl: resolvedUshipUrl } : {}),
                            ...(listingId && lead.externalShipmentId !== listingId
                                ? { externalShipmentId: listingId }
                                : {}),
                        },
                    })
                    .catch(() => null);
            }
        } else if (openUshipUrl && !lead.viewUrl) {
            // Persist Instant Alert CTA so list/Open keep working without re-reading HTML.
            await prisma.shipmentLead
                .update({
                    where: { shipmentLeadId: lead.shipmentLeadId },
                    data: { viewUrl: openUshipUrl },
                })
                .catch(() => null);
        }

        const enriched = enrichLead(
            {
                ...(lead as unknown as Record<string, unknown>),
                greenOsShipmentId: greenOsShipmentId || lead.greenOsShipmentId,
                viewUrl: openUshipUrl || lead.viewUrl,
                externalShipmentId:
                    lead.externalShipmentId || listingIdFromText(resolvedUshipUrl || "") || null,
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
                      snippet: lead.emailMessage.snippet,
                  }
                : null,
        };
    }

    /** Find the uShip listing for this card, including a live Gmail re-read if needed. */
    async resolveUshipListingUrl(shipmentLeadId: string): Promise<string | null> {
        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId },
            include: {
                emailMessage: true,
                importLogs: { orderBy: { createdAt: "desc" }, take: 30 },
                domainEvents: { orderBy: { createdAt: "desc" }, take: 80 },
            },
        });
        if (!lead) return null;

        const mailboxEmails = await prisma.brokerMailboxMessage.findMany({
            where: { shipmentLeadId },
            orderBy: { receivedAt: "asc" },
            take: 80,
            select: { subject: true, snippet: true, bodyText: true },
        });
        const extraBlobs = [
            lead.emailMessage?.subject,
            lead.emailMessage?.snippet,
            lead.emailMessage?.bodyText,
            lead.emailMessage?.bodyHtml,
            lead.documentsJson,
            ...mailboxEmails.map((m) => m.subject),
            ...mailboxEmails.map((m) => m.snippet),
            ...mailboxEmails.map((m) => m.bodyText),
            ...lead.importLogs.map((log) => log.message),
            ...lead.domainEvents.map((ev) => ev.message),
            ...lead.domainEvents.map((ev) => ev.payloadJson),
        ];
        let url = ushipListingUrlFromLead(lead as unknown as Record<string, unknown>, extraBlobs);
        if (!hasRealListingSlug(url)) url = null;

        const stickyId = isUshipListingId(lead.externalShipmentId)
            ? String(lead.externalShipmentId)
            : listingIdFromText(lead.viewUrl || "");
        const currentView = String(lead.viewUrl || "");
        const needsLiveRead = !url || isUshipTrackingOrJunkUrl(currentView);

        if (needsLiveRead) {
            try {
                const brokerBlobs = await brokerGmailSyncService.listingSourceBlobsForShipment(
                    shipmentLeadId
                );
                if (brokerBlobs.length) {
                    extraBlobs.push(...brokerBlobs);
                    url = ushipListingUrlFromLead(lead as unknown as Record<string, unknown>, extraBlobs);
                    if (!hasRealListingSlug(url)) url = null;
                }
            } catch {
                /* broker Gmail re-read is best-effort */
            }
        }

        if (needsLiveRead && lead.emailMessage?.gmailMessageId) {
            try {
                if (await gmailListener.ensureCredentials()) {
                    const raw = await gmailListener.fetchMessage(lead.emailMessage.gmailMessageId);
                    extraBlobs.push(raw.subject, raw.snippet, raw.bodyText, raw.bodyHtml);
                    url = ushipListingUrlFromLead(lead as unknown as Record<string, unknown>, extraBlobs);
                    if (!hasRealListingSlug(url)) url = null;
                    if (raw.bodyHtml || raw.bodyText) {
                        await prisma.emailMessage
                            .update({
                                where: { emailMessageId: lead.emailMessage.emailMessageId },
                                data: {
                                    bodyHtml: raw.bodyHtml || lead.emailMessage.bodyHtml,
                                    bodyText: raw.bodyText || lead.emailMessage.bodyText,
                                    snippet: raw.snippet || lead.emailMessage.snippet,
                                },
                            })
                            .catch(() => null);
                    }
                }
            } catch {
                /* Gmail re-read is best-effort */
            }
        }

        if (!url) {
            try {
                const searched = await brokerGmailSyncService.searchListingBlobsForLead({
                    assignedBrokerId: lead.assignedBrokerId,
                    pickupCity: lead.pickupCity,
                    deliveryCity: lead.deliveryCity,
                    pickupZip: lead.pickupZip,
                    deliveryZip: lead.deliveryZip,
                    shipmentTitle: lead.shipmentTitle,
                    miles: lead.miles,
                });
                if (searched.length) {
                    extraBlobs.push(...searched);
                    url = ushipListingUrlFromLead(lead as unknown as Record<string, unknown>, extraBlobs);
                    if (!hasRealListingSlug(url)) url = null;
                }
            } catch {
                /* live Gmail search is best-effort */
            }
        }

        if (!url) {
            const trackers = trackingUrlsFromText(currentView, ...extraBlobs).slice(0, 6);
            for (const tracker of trackers) {
                url = await followUshipToListingUrl(tracker);
                if (hasRealListingSlug(url)) break;
                url = null;
            }
        }

        const listingId = listingIdFromText(url || "") || stickyId || null;

        if (url && hasRealListingSlug(url)) {
            const shouldFixView =
                !currentView ||
                isUshipTrackingOrJunkUrl(currentView) ||
                !hasRealListingSlug(currentView) ||
                (listingId &&
                    !currentView.includes(`/listing/${listingId}`) &&
                    !currentView.includes(`/${listingId}`));
            if (shouldFixView || (listingId && lead.externalShipmentId !== listingId)) {
                await prisma.shipmentLead
                    .update({
                        where: { shipmentLeadId },
                        data: {
                            ...(shouldFixView ? { viewUrl: url } : {}),
                            ...(listingId ? { externalShipmentId: listingId } : {}),
                        },
                    })
                    .catch(() => null);
            }
            return url;
        }

        // No concrete page — open the Instant Alert CTA in the broker's browser.
        const cta = ushipOpenUrlFromLead(lead as unknown as Record<string, unknown>, extraBlobs);
        if (cta) {
            if (!currentView) {
                await prisma.shipmentLead
                    .update({
                        where: { shipmentLeadId },
                        data: { viewUrl: cta },
                    })
                    .catch(() => null);
            }
            return cta;
        }
        return null;
    }

    private async getBrokerPresenceSummary(options?: { teamLeadId?: string }) {
        const teamUserIds = options?.teamLeadId
            ? await listTeamBrokerIds(options.teamLeadId)
            : null;
        const brokers = await prisma.user.findMany({
            where: {
                isActive: true,
                ...(teamUserIds
                    ? { userId: { in: teamUserIds } }
                    : {
                          role: {
                              roleName: {
                                  in: ["Broker", "Team Lead", "Manager", "Accounting", "Owner"],
                              },
                          },
                      }),
            },
            select: {
                userId: true,
                employeeId: true,
                role: { select: { roleName: true } },
            },
        });
        // Queue roster is Brokers + Team Leads (same as assignment after 01:00).
        const queuePool = brokers.filter(
            (b) => b.role.roleName === "Broker" || b.role.roleName === "Team Lead"
        );
        const pool = queuePool.length ? queuePool : brokers;
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
            (b) => b.employeeId && inOfficeIds.has(b.employeeId)
        );
        const shipmentsToPresentBrokers = presentBrokers.reduce(
            (sum, b) => sum + (activeByBroker.get(b.userId) || 0),
            0
        );
        const shipmentsToAllAssignedBrokers = pool.reduce(
            (sum, b) => sum + (activeByBroker.get(b.userId) || 0),
            0
        );
        const afterHours = isAfterHoursAssignment(new Date(), ASSIGNMENT_TIMEZONE);
        const assignmentMode = chooseAssignmentPool({
            afterHours,
            linkedCount: pool.length,
            inOfficeCount: presentBrokers.length,
        });
        const ownerActiveLoads =
            assignmentMode === "after_hours"
                ? shipmentsToAllAssignedBrokers
                : assignmentMode === "in_office"
                  ? shipmentsToPresentBrokers
                  : 0;

        return {
            presentBrokerCount: presentBrokers.filter((b) => b.role.roleName === "Broker")
                .length,
            assignmentMode,
            ownerActiveLoads,
            shipmentsToPresentBrokers,
        };
    }

    /**
     * Shipments where this broker already placed a bid.
     * Status often moves on to Broker Reply, so the current status alone is not enough.
     */
    private async countShipmentsWithBid(brokerIds: string[]): Promise<Map<string, number>> {
        const byBroker = new Map<string, Set<string>>();
        const add = (brokerId: string | null | undefined, shipmentId: string | null | undefined) => {
            if (!brokerId || !shipmentId) return;
            const set = byBroker.get(brokerId) || new Set<string>();
            set.add(shipmentId);
            byBroker.set(brokerId, set);
        };
        if (!brokerIds.length) return new Map();

        const [leads, events] = await Promise.all([
            prisma.shipmentLead.findMany({
                where: {
                    assignedBrokerId: { in: brokerIds },
                    OR: [
                        { quoteSentAt: { not: null } },
                        { status: { in: ["BID_SUBMITTED", "QUOTE_SENT"] } },
                    ],
                },
                select: { shipmentLeadId: true, assignedBrokerId: true },
            }),
            prisma.domainEvent.findMany({
                where: {
                    eventType: "BID_SUBMITTED",
                    shipmentLead: { assignedBrokerId: { in: brokerIds } },
                },
                select: {
                    shipmentLeadId: true,
                    shipmentLead: { select: { assignedBrokerId: true } },
                },
            }),
        ]);
        for (const lead of leads) add(lead.assignedBrokerId, lead.shipmentLeadId);
        for (const event of events) add(event.shipmentLead?.assignedBrokerId, event.shipmentLeadId);

        const counts = new Map<string, number>();
        for (const [brokerId, ids] of byBroker) counts.set(brokerId, ids.size);
        return counts;
    }

    /**
     * One round-trip for My Shipments tab badges (New / Other / Accepted / …).
     * Uses count-only queries — no row hydration.
     */
    async countBrokerShipmentTabs(brokerId: string) {
        try {
            const { assignmentEngine } = await import("../../assignment/assignment.engine.js");
            await assignmentEngine.repairPassedShipmentFlags();
        } catch {
            /* counts still work if repair is busy */
        }
        const base = { brokerId, countOnly: true as const, lite: true as const, skipRepair: true as const };
        const [newMeta, otherMeta, acceptedMeta, loadsMeta, aacMeta, nlrMeta, declineMeta] =
            await Promise.all([
                this.listShipments({ ...base, assignmentKind: "new" }),
                this.listShipments({ ...base, assignmentKind: "other" }),
                this.listShipments({ ...base, assignmentKind: "accepted" }),
                this.listShipments({ ...base, assignmentKind: "loads" }),
                this.listShipments({ ...base, status: "ACCEPTED_ANOTHER_COMPANY" }),
                this.listShipments({ ...base, status: "NO_LONGER_NEEDED" }),
                this.listShipments({ ...base, status: "ROUND_DECLINED" }),
            ]);
        return {
            new: newMeta.total,
            other: otherMeta.total,
            accepted: acceptedMeta.total,
            loads: loadsMeta.total,
            acceptedAnother: aacMeta.total,
            noLongerNeeded: nlrMeta.total,
            decline: declineMeta.total,
        };
    }

    async getBrokerWorkload(options?: {
        teamLeadId?: string;
        /** Limit to these user ids (e.g. one broker workspace). */
        brokerIds?: string[];
        /** Brokers list / Give-to — skip avg response + bid scan. */
        summary?: boolean;
    }) {
        const teamUserIds = options?.teamLeadId
            ? await listTeamBrokerIds(options.teamLeadId)
            : null;
        const scopedIds = options?.brokerIds?.filter(Boolean) || null;
        const brokers = await prisma.user.findMany({
            where: {
                isActive: true,
                ...(scopedIds
                    ? { userId: { in: scopedIds } }
                    : teamUserIds
                      ? { userId: { in: teamUserIds } }
                      : {
                            role: {
                                roleName: {
                                    in: ["Broker", "Team Lead", "Manager", "Accounting", "Owner"],
                                },
                            },
                        }),
            },
            include: {
                role: true,
                teamLead: { select: { userId: true, firstName: true, lastName: true, username: true } },
            },
            orderBy: { firstName: "asc" },
        });
        const pool = scopedIds
            ? brokers
            : teamUserIds
              ? brokers
              : brokers.filter(
                    (b) => b.role.roleName === "Broker" || b.role.roleName === "Team Lead"
                );
        const poolIds = pool.map((b) => b.userId);
        const employeeIds = pool
            .map((b) => b.employeeId)
            .filter((id): id is string => Boolean(id));
        const summary = options?.summary === true;

        const [statusCounts, acceptedRows, inOfficeIds, bidCounts] = await Promise.all([
            poolIds.length
                ? prisma.shipmentLead.groupBy({
                      by: ["assignedBrokerId", "status"],
                      where: { assignedBrokerId: { in: poolIds } },
                      _count: { _all: true },
                  })
                : Promise.resolve([]),
            summary || !poolIds.length
                ? Promise.resolve(
                      [] as Array<{
                          assignedBrokerId: string | null;
                          assignedAt: Date | null;
                          acceptedAt: Date | null;
                      }>
                  )
                : prisma.shipmentLead.findMany({
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
            summary || !poolIds.length
                ? Promise.resolve(new Map<string, number>())
                : this.countShipmentsWithBid(poolIds),
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
                followUp: countFor("FOLLOW_UP") + countFor("BROKER_REPLY"),
                quotesSent: bidCounts.get(b.userId) || 0,
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

        // Only this broker — never scan every staff member's accepted/bid history.
        const [workload, shipments] = await Promise.all([
            this.getBrokerWorkload({ brokerIds: [brokerId] }),
            this.listShipments({ brokerId, limit: 200, pageSize: 200, lite: true }),
        ]);
        const stats = workload.find((b) => b.brokerId === brokerId);

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
            shipments: shipments.items,
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

    /** uShip quote/bid confirmation, or the broker clicked Bid Submitted. */
    async markBidSubmitted(shipmentLeadId: string, actorUserId: string) {
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
                throw Object.assign(new Error("Only the assigned broker can mark Bid Submitted"), {
                    status: 403,
                });
            }
        }
        const current = normalizeStatus(lead.status);
        const alreadyBid = new Set([
            "BID_SUBMITTED",
            "QUOTE_SENT",
            "CUSTOMER_REPLIED",
            "BROKER_REPLY",
            "ACCEPT_GREEN",
            "ACCEPTED",
            "LOAD_CREATED",
        ]);
        if (!alreadyBid.has(current) && !isLoadPhase(current)) {
            await shipmentService.transitionStatus({
                shipmentLeadId,
                status: "BID_SUBMITTED",
                actorUserId,
                skipLifecycleCheck: true,
            });
        }
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "BID_SUBMITTED",
            title: "Bid Submitted",
            message: "Bid placed on uShip",
            actorUserId,
            payload: { source: "manual_bid" },
            timelineStage: "BID_SUBMITTED",
        });
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
            ["WORKING", "BID_SUBMITTED", "AGENT_OPEN", "FOLLOW_UP", "BROKER_REPLY"].includes(
                lead.status
            ) ||
            lead.status === "CUSTOMER_REPLIED"
        ) {
            await prisma.shipmentLead.update({
                where: { shipmentLeadId },
                data: { status: "BROKER_REPLY" },
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
        const allowEnv = String(process.env.ALLOW_TEST_CUSTOMER_ACCEPT || "0").toLowerCase();
        const testEnabled = ["1", "true", "yes", "on"].includes(allowEnv);

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

        if (!testEnabled) {
            throw Object.assign(
                new Error("Test Customer Accept is disabled. Accept Green comes only from the customer's uShip booking email."),
                { status: 403 }
            );
        }
        if (!isOps) {
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
