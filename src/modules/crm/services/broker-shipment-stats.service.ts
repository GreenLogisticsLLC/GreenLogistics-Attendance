import { prisma } from "../../../config/database.js";
import { listTeamBrokerIds } from "../../../auth/team-scope.js";
import { Roles } from "../../../auth/roles.js";

export type BrokerStatShipment = {
    shipmentLeadId: string;
    title: string;
    greenOsShipmentId: string | null;
    customerName: string | null;
    status: string;
};

export type BrokerShipmentStat = {
    brokerId: string;
    name: string;
    newReceived: number;
    otherReceived: number;
    accepted: number;
    newNotAccepted: number;
    newShipments: BrokerStatShipment[];
    otherShipments: BrokerStatShipment[];
    acceptedShipments: BrokerStatShipment[];
    newNotAcceptedShipments: BrokerStatShipment[];
};

type Arrival = { brokerId: string; shipmentId: string; kind: "new" | "other" };

function payloadBroker(raw: string | null, actorUserId: string | null): Arrival | null {
    let brokerId = actorUserId || "";
    let reassignFrom: string | null = null;
    try {
        const payload = JSON.parse(raw || "{}") as {
            brokerId?: string;
            reassignFrom?: string | null;
        };
        if (payload.brokerId) brokerId = String(payload.brokerId);
        reassignFrom = payload.reassignFrom || null;
    } catch {
        reassignFrom = null;
    }
    if (!brokerId) return null;
    return { brokerId, shipmentId: "", kind: reassignFrom ? "other" : "new" };
}

export class BrokerShipmentStatsService {
    async forTeamLead(teamLeadUserId: string): Promise<{
        brokers: Array<{ userId: string; name: string }>;
        rows: BrokerShipmentStat[];
    }> {
        const teamIds = await listTeamBrokerIds(teamLeadUserId);
        const brokers = await prisma.user.findMany({
            where: {
                userId: { in: teamIds.length ? teamIds : ["__none__"] },
                role: { roleName: Roles.Broker },
            },
            select: { userId: true, firstName: true, lastName: true, username: true },
            orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
        });
        const brokerIds = brokers.map((b) => b.userId);
        if (!brokerIds.length) {
            return { brokers: [], rows: [] };
        }

        const [logs, events] = await Promise.all([
            prisma.assignmentLog.findMany({
                where: {
                    assignedUserId: { in: brokerIds },
                    eventType: { in: ["ASSIGNED", "REASSIGNED"] },
                    shipmentLeadId: { not: null },
                },
                select: { shipmentLeadId: true, assignedUserId: true, eventType: true },
            }),
            prisma.domainEvent.findMany({
                where: {
                    eventType: "BROKER_ASSIGNED",
                    actorUserId: { in: brokerIds },
                },
                select: { shipmentLeadId: true, actorUserId: true, payloadJson: true },
            }),
        ]);
        const referenced = new Set<string>();
        for (const log of logs) {
            if (log.shipmentLeadId) referenced.add(log.shipmentLeadId);
        }
        for (const event of events) {
            if (event.shipmentLeadId) referenced.add(event.shipmentLeadId);
        }
        const leads = await prisma.shipmentLead.findMany({
            where: {
                status: { not: "DELETED_FROM_CUSTOMER" },
                OR: [
                    ...(referenced.size
                        ? [{ shipmentLeadId: { in: [...referenced] } }]
                        : []),
                    { assignedBrokerId: { in: brokerIds } },
                ],
            },
            select: {
                shipmentLeadId: true,
                shipmentTitle: true,
                greenOsShipmentId: true,
                customerName: true,
                assignedBrokerId: true,
                acceptedAt: true,
                isReassignment: true,
                wasEverReassigned: true,
                status: true,
            },
        });

        const live = new Map(leads.map((lead) => [lead.shipmentLeadId, lead]));
        const arrivals = new Map<string, Map<string, Set<"new" | "other">>>();
        const touch = (brokerId: string, shipmentId: string, kind: "new" | "other") => {
            if (!brokerIds.includes(brokerId) || !shipmentId || !live.has(shipmentId)) return;
            let byShipment = arrivals.get(brokerId);
            if (!byShipment) {
                byShipment = new Map();
                arrivals.set(brokerId, byShipment);
            }
            let kinds = byShipment.get(shipmentId);
            if (!kinds) {
                kinds = new Set();
                byShipment.set(shipmentId, kinds);
            }
            kinds.add(kind);
        };

        for (const log of logs) {
            if (!log.assignedUserId || !log.shipmentLeadId) continue;
            touch(
                log.assignedUserId,
                log.shipmentLeadId,
                log.eventType === "REASSIGNED" ? "other" : "new"
            );
        }
        for (const event of events) {
            if (!event.shipmentLeadId) continue;
            const parsed = payloadBroker(event.payloadJson, event.actorUserId);
            if (!parsed) continue;
            touch(parsed.brokerId, event.shipmentLeadId, parsed.kind);
        }

        for (const lead of leads) {
            const brokerId = lead.assignedBrokerId;
            if (!brokerId || !brokerIds.includes(brokerId)) continue;
            const already = arrivals.get(brokerId)?.has(lead.shipmentLeadId);
            if (already) continue;
            const other = Boolean(lead.isReassignment || lead.wasEverReassigned);
            touch(brokerId, lead.shipmentLeadId, other ? "other" : "new");
        }

        const brief = (shipmentId: string): BrokerStatShipment => {
            const lead = live.get(shipmentId);
            return {
                shipmentLeadId: shipmentId,
                title: lead?.shipmentTitle || "Shipment",
                greenOsShipmentId: lead?.greenOsShipmentId || null,
                customerName: lead?.customerName || null,
                status: lead?.status || "",
            };
        };
        const rows = brokers.map((broker) => {
            const byShipment = arrivals.get(broker.userId) || new Map();
            const newShipments: BrokerStatShipment[] = [];
            const otherShipments: BrokerStatShipment[] = [];
            const acceptedShipments: BrokerStatShipment[] = [];
            const newNotAcceptedShipments: BrokerStatShipment[] = [];
            for (const [shipmentId, kinds] of byShipment) {
                const lead = live.get(shipmentId);
                const took =
                    Boolean(lead?.acceptedAt) && lead?.assignedBrokerId === broker.userId;
                const card = brief(shipmentId);
                if (kinds.has("new")) newShipments.push(card);
                if (kinds.has("other")) otherShipments.push(card);
                if (took) acceptedShipments.push(card);
                if (kinds.has("new") && !(took && !kinds.has("other"))) {
                    newNotAcceptedShipments.push(card);
                }
            }
            const byTitle = (a: BrokerStatShipment, b: BrokerStatShipment) =>
                a.title.localeCompare(b.title);
            newShipments.sort(byTitle);
            otherShipments.sort(byTitle);
            acceptedShipments.sort(byTitle);
            newNotAcceptedShipments.sort(byTitle);
            const name =
                `${broker.firstName} ${broker.lastName}`.trim() || broker.username;
            return {
                brokerId: broker.userId,
                name,
                newReceived: newShipments.length,
                otherReceived: otherShipments.length,
                accepted: acceptedShipments.length,
                newNotAccepted: newNotAcceptedShipments.length,
                newShipments,
                otherShipments,
                acceptedShipments,
                newNotAcceptedShipments,
            };
        });

        return {
            brokers: rows.map((row) => ({ userId: row.brokerId, name: row.name })),
            rows,
        };
    }
}

export const brokerShipmentStatsService = new BrokerShipmentStatsService();
