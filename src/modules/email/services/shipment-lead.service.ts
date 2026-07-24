import { prisma } from "../../../config/database.js";
import type { ParsedShipmentDraft, ShipmentLeadStatus } from "../models/types.js";
import {
    shipmentImportLogRepository,
    shipmentLeadRepository,
} from "./repositories.js";

const ACCEPTANCE_MINUTES = 15;

/**
 * After ShipmentLead is created:
 * Email → Parser → Lead(NEW) → Assignment → Acceptance Timer → Follow-up → Quote → Won/Lost
 */
export class AssignmentEngine {
    async startPipeline(shipmentLeadId: string) {
        const lead = await shipmentLeadRepository.findById(shipmentLeadId);
        if (!lead || lead.status !== "NEW") return lead;

        const broker = await this.pickBroker();
        if (!broker) {
            await this.log(shipmentLeadId, "No broker available — lead stays NEW");
            return lead;
        }

        const acceptanceDeadline = new Date(Date.now() + ACCEPTANCE_MINUTES * 60_000);
        const assigned = await shipmentLeadRepository.update(shipmentLeadId, {
            status: "ASSIGNED",
            assignedBrokerId: broker.userId,
            assignedAt: new Date(),
            acceptanceDeadline,
        });
        await this.log(
            shipmentLeadId,
            `Assigned to broker ${broker.username} (${broker.userId}); acceptance deadline ${acceptanceDeadline.toISOString()}`
        );

        // Move into awaiting acceptance immediately after assignment.
        const awaiting = await shipmentLeadRepository.update(shipmentLeadId, {
            status: "AWAITING_ACCEPTANCE",
        });
        await this.log(shipmentLeadId, "Status → AWAITING_ACCEPTANCE");
        return awaiting || assigned;
    }

    async processDueAcceptances() {
        const now = new Date();
        const expired = await prisma.shipmentLead.findMany({
            where: {
                status: "AWAITING_ACCEPTANCE",
                acceptanceDeadline: { lt: now },
            },
            take: 50,
        });

        for (const lead of expired) {
            await shipmentLeadRepository.update(lead.shipmentLeadId, {
                status: "FOLLOW_UP",
            });
            await this.log(
                lead.shipmentLeadId,
                "Acceptance timer expired → FOLLOW_UP"
            );
        }
        return expired.length;
    }

    async markQuoteSent(shipmentLeadId: string) {
        const updated = await shipmentLeadRepository.update(shipmentLeadId, {
            status: "QUOTE_SENT" satisfies ShipmentLeadStatus,
            quoteSentAt: new Date(),
        });
        await this.log(shipmentLeadId, "Status → QUOTE_SENT");
        return updated;
    }

    async closeLead(shipmentLeadId: string, outcome: "WON" | "LOST") {
        const updated = await shipmentLeadRepository.update(shipmentLeadId, {
            status: outcome,
            closedAt: new Date(),
        });
        await this.log(shipmentLeadId, `Status → ${outcome}`);
        return updated;
    }

    private async pickBroker() {
        const brokers = await prisma.user.findMany({
            where: {
                isActive: true,
                role: { roleName: { in: ["Broker", "Manager", "Owner", "Administrator"] } },
            },
            orderBy: { createdAt: "asc" },
            include: { role: true },
        });
        if (!brokers.length) return null;

        // Prefer Broker role, then fall back.
        const preferred = brokers.filter((b) => b.role.roleName === "Broker");
        const pool = preferred.length ? preferred : brokers;

        const openCounts = await Promise.all(
            pool.map(async (b) => ({
                user: b,
                open: await prisma.shipmentLead.count({
                    where: {
                        assignedBrokerId: b.userId,
                        status: { in: ["ASSIGNED", "AWAITING_ACCEPTANCE", "FOLLOW_UP", "QUOTE_SENT"] },
                    },
                }),
            }))
        );
        openCounts.sort((a, b) => a.open - b.open);
        return openCounts[0]?.user || null;
    }

    private async log(shipmentLeadId: string, message: string) {
        await shipmentImportLogRepository.create({
            eventType: "PipelineEvent",
            message,
            shipmentLeadId,
        });
    }
}

export class ShipmentLeadService {
    constructor(private readonly assignmentEngine = new AssignmentEngine()) {}

    async createFromParsed(input: {
        draft: ParsedShipmentDraft;
        emailMessageId: string;
        gmailMessageId: string;
    }) {
        const { draft, emailMessageId, gmailMessageId } = input;

        if (draft.viewUrl) {
            const byUrl = await shipmentLeadRepository.findByViewUrl(draft.viewUrl);
            if (byUrl) {
                await shipmentImportLogRepository.create({
                    eventType: "DuplicateShipment",
                    message: `Duplicate by viewUrl: ${draft.viewUrl}`,
                    gmailMessageId,
                    emailMessageId,
                    shipmentLeadId: byUrl.shipmentLeadId,
                });
                return { duplicate: true as const, lead: byUrl };
            }
        }

        if (draft.externalShipmentId) {
            const byExternal = await shipmentLeadRepository.findByExternalId(
                draft.source,
                draft.externalShipmentId
            );
            if (byExternal) {
                await shipmentImportLogRepository.create({
                    eventType: "DuplicateShipment",
                    message: `Duplicate by externalShipmentId: ${draft.externalShipmentId}`,
                    gmailMessageId,
                    emailMessageId,
                    shipmentLeadId: byExternal.shipmentLeadId,
                });
                return { duplicate: true as const, lead: byExternal };
            }
        }

        const lead = await shipmentLeadRepository.create({
            source: draft.source,
            externalShipmentId: draft.externalShipmentId,
            shipmentTitle: draft.shipmentTitle,
            pickupCity: draft.pickupCity,
            pickupState: draft.pickupState,
            pickupZip: draft.pickupZip,
            deliveryCity: draft.deliveryCity,
            deliveryState: draft.deliveryState,
            deliveryZip: draft.deliveryZip,
            pickupFrom: draft.pickupFrom || undefined,
            pickupTo: draft.pickupTo || undefined,
            deliveryFrom: draft.deliveryFrom || undefined,
            deliveryTo: draft.deliveryTo || undefined,
            miles: draft.miles ?? undefined,
            category: draft.category,
            imageUrl: draft.imageUrl,
            viewUrl: draft.viewUrl,
            status: "NEW",
            emailMessageId,
            receivedAt: draft.receivedAt || new Date(),
        });

        await shipmentImportLogRepository.create({
            eventType: "EmailImported",
            message: `Imported shipment lead: ${lead.shipmentTitle}`,
            gmailMessageId,
            emailMessageId,
            shipmentLeadId: lead.shipmentLeadId,
        });

        await this.assignmentEngine.startPipeline(lead.shipmentLeadId);
        const refreshed = await shipmentLeadRepository.findById(lead.shipmentLeadId);
        return { duplicate: false as const, lead: refreshed || lead };
    }

    list(limit?: number) {
        return shipmentLeadRepository.list(limit);
    }

    getById(id: string) {
        return shipmentLeadRepository.findById(id);
    }

    get assignment() {
        return this.assignmentEngine;
    }
}

export const shipmentLeadService = new ShipmentLeadService();
export const assignmentEngine = shipmentLeadService.assignment;
