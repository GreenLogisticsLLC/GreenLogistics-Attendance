import { prisma } from "../../../config/database.js";
import { listTeamBrokerIds } from "../../../auth/team-scope.js";
import { Roles } from "../../../auth/roles.js";

export type BrokerShipmentStat = {
    brokerId: string;
    name: string;
    newReceived: number;
    otherReceived: number;
    accepted: number;
    newNotAccepted: number;
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

        const rows = brokers.map((broker) => {
            const byShipment = arrivals.get(broker.userId) || new Map();
            let newReceived = 0;
            let otherReceived = 0;
            let accepted = 0;
            let newNotAccepted = 0;
            for (const [shipmentId, kinds] of byShipment) {
                const lead = live.get(shipmentId);
                const took =
                    Boolean(lead?.acceptedAt) && lead?.assignedBrokerId === broker.userId;
                if (kinds.has("new")) newReceived += 1;
                if (kinds.has("other")) otherReceived += 1;
                if (took) accepted += 1;
                if (kinds.has("new") && !(took && !kinds.has("other"))) newNotAccepted += 1;
            }
            const name =
                `${broker.firstName} ${broker.lastName}`.trim() || broker.username;
            return {
                brokerId: broker.userId,
                name,
                newReceived,
                otherReceived,
                accepted,
                newNotAccepted,
            };
        });

        return {
            brokers: rows.map((row) => ({ userId: row.brokerId, name: row.name })),
            rows,
        };
    }
}

export const brokerShipmentStatsService = new BrokerShipmentStatsService();
