import { prisma } from "../../../config/database.js";
import { listTeamBrokerIds } from "../../../auth/team-scope.js";
import { carrierService } from "../../carriers/services/carrier.service.js";
import { operationalAiService } from "../operational/index.js";
import { communicationService } from "../communications/index.js";
import { marketRateService } from "../rates/index.js";
import type { CarrierOperationalSummary, ShipmentOperationalSummary } from "../operational/types.js";
import type { CommunicationContext } from "../communications/types.js";
import type { CommandCenterActor, AiOperationalItem } from "./types.js";
import { determineOperationalPriority } from "./priority.js";
import { documentDedupeKey } from "./dedupe.js";
import { shipmentLifecycleService } from "../lifecycle/service.js";
import type { ShipmentLifecycleContext } from "../lifecycle/types.js";

const SHIPMENT_LIMIT = 35;
const CARRIER_LIMIT = 20;
const CLOSED_STATUSES = ["CLOSED", "LOST", "DELETED"];

type ShipmentRow = {
    shipmentLeadId: string;
    loadNumber: string | null;
    greenOsShipmentId: string | null;
    shipmentTitle: string;
    status: string;
    carrierProfileId: string | null;
    carrierRate: number | null;
    customerRate: number | null;
    assignedBrokerId: string | null;
    updatedAt: Date;
};

function source(type: string, id: string, label: string) {
    return { type, id, label };
}

function idFor(key: string): string {
    return `cc:${key}`;
}

function shipmentLabel(row: ShipmentRow): string {
    return row.loadNumber || row.greenOsShipmentId || row.shipmentTitle || row.shipmentLeadId;
}

async function listScopedShipments(
    actor: CommandCenterActor,
    myWork: boolean
): Promise<ShipmentRow[]> {
    const where: Record<string, unknown> = { status: { notIn: CLOSED_STATUSES } };
    if (actor.role === "Broker" || myWork) {
        where.assignedBrokerId = actor.userId;
    } else if (actor.role === "Team Lead") {
        const teamIds = await listTeamBrokerIds(actor.userId);
        where.OR = [
            { assignedBrokerId: { in: teamIds } },
            { assignedBrokerId: null },
            { status: { in: ["NEW", "UNASSIGNED"] } },
        ];
    }
    return prisma.shipmentLead.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: SHIPMENT_LIMIT,
        select: {
            shipmentLeadId: true,
            loadNumber: true,
            greenOsShipmentId: true,
            shipmentTitle: true,
            status: true,
            carrierProfileId: true,
            carrierRate: true,
            customerRate: true,
            assignedBrokerId: true,
            updatedAt: true,
        },
    });
}

async function listScopedCarriers(actor: CommandCenterActor, shipments: ShipmentRow[]) {
    if (actor.role === "Team Lead") {
        const ids = [...new Set(shipments.map((row) => row.carrierProfileId).filter(Boolean))] as string[];
        if (!ids.length) return [];
        return prisma.carrier.findMany({
            where: { carrierId: { in: ids } },
            orderBy: { updatedAt: "desc" },
            take: CARRIER_LIMIT,
        });
    }
    const rows = await carrierService.list(actor, {});
    return rows.slice(0, CARRIER_LIMIT);
}

function documentItems(
    entityType: "shipment" | "carrier",
    entityId: string,
    label: string,
    documents: Array<{
        slot: string;
        status: string;
        reason: string;
        documentId: string | null;
    }>,
    readiness: string,
    closingMatters: boolean
): AiOperationalItem[] {
    return documents
        .filter((doc) =>
            ["MISSING", "INVALID", "EXPIRED", "REVIEW_REQUIRED"].includes(doc.status)
        )
        .map((doc) => {
            const key = documentDedupeKey(entityType, entityId, doc.slot);
            const priority = determineOperationalPriority({
                category: "DOCUMENT",
                entityType,
                readiness,
                documentStatus: doc.status,
                documentType: doc.slot,
                closingMatters,
            });
            return {
                id: idFor(key),
                category: "DOCUMENT",
                priority,
                severity: doc.status,
                title: `${doc.slot} ${doc.status.toLowerCase().replace(/_/g, " ")}`,
                summary: `${label} requires ${doc.slot} attention.`,
                entityType,
                entityId,
                entityLabel: label,
                status: doc.status,
                reason: doc.reason || `${doc.slot} is ${doc.status.toLowerCase()}.`,
                nextBestAction:
                    doc.status === "MISSING" ? "REQUEST_DOCUMENT" : "REVIEW_DOCUMENT",
                sources: [
                    source(
                        doc.documentId ? "document" : entityType,
                        doc.documentId || entityId,
                        doc.slot
                    ),
                ],
                blocking: priority === "CRITICAL" || priority === "HIGH",
                dedupeKey: key,
            } satisfies AiOperationalItem;
        });
}

function mismatchItems(
    carrierId: string,
    label: string,
    summary: CarrierOperationalSummary
): AiOperationalItem[] {
    return summary.mismatches
        .filter((mismatch) => mismatch.status !== "MATCH")
        .map((mismatch) => {
            const key = `carrier:${carrierId}:compliance:${mismatch.field}`;
            return {
                id: idFor(key),
                category: "COMPLIANCE",
                priority: determineOperationalPriority({
                    category: "COMPLIANCE",
                    mismatchStatus: mismatch.status,
                }),
                severity: mismatch.status,
                title: `Compliance ${mismatch.status.toLowerCase().replace(/_/g, " ")}`,
                summary: mismatch.message,
                entityType: "carrier",
                entityId: carrierId,
                entityLabel: label,
                status: mismatch.status,
                reason: mismatch.message,
                nextBestAction: "REVIEW_COMPLIANCE",
                sources: summary.sources.map((s) => source(s.type, s.id, s.label)),
                blocking: mismatch.status === "CRITICAL_MISMATCH",
                dedupeKey: key,
            };
        });
}

function communicationItems(context: CommunicationContext, label: string): AiOperationalItem[] {
    const entityType = context.entityType;
    const entityId = context.entityId;
    const items: AiOperationalItem[] = [];
    for (const request of context.openRequests) {
        const isDocument = Boolean(request.documentType);
        const key = isDocument
            ? documentDedupeKey(entityType, entityId, request.documentType!)
            : `${entityType}:${entityId}:communication:${request.requestType}`;
        items.push({
            id: idFor(key),
            category: isDocument ? "DOCUMENT" : "COMMUNICATION",
            priority: determineOperationalPriority({
                category: "COMMUNICATION",
                blocking: context.waitingFor === "WAITING_FOR_DOCUMENT",
                followUpNeeded: context.followUp.needed === "YES",
                status: "PENDING_RESPONSE",
            }),
            title: isDocument
                ? `${request.documentType} request pending`
                : "Response pending",
            summary: `${label} is ${context.waitingFor.toLowerCase().replace(/_/g, " ")}.`,
            entityType,
            entityId,
            entityLabel: label,
            status: request.lifecycle,
            reason: context.followUp.reason || `Request ${request.requestType} remains open.`,
            nextBestAction: isDocument ? "REQUEST_DOCUMENT" : "FOLLOW_UP",
            sources: context.sources.map((s) => source(s.type, s.id, s.label)),
            blocking: context.waitingFor === "WAITING_FOR_DOCUMENT",
            dedupeKey: key,
        });
    }
    if (!context.openRequests.length && context.followUp.needed === "YES") {
        const key = `${entityType}:${entityId}:follow-up`;
        items.push({
            id: idFor(key),
            category: "FOLLOW_UP",
            priority: "MEDIUM",
            title: "Follow-up recommended",
            summary: `${label} needs a communication follow-up.`,
            entityType,
            entityId,
            entityLabel: label,
            status: context.waitingFor,
            reason: context.followUp.reason,
            nextBestAction: "FOLLOW_UP",
            sources: context.sources.map((s) => source(s.type, s.id, s.label)),
            dedupeKey: key,
        });
    }
    return items;
}

function shipmentReadinessItem(
    row: ShipmentRow,
    summary: ShipmentOperationalSummary
): AiOperationalItem | null {
    if (summary.readiness === "READY_TO_CLOSE") return null;
    const label = shipmentLabel(row);
    const key = `shipment:${row.shipmentLeadId}:readiness`;
    return {
        id: idFor(key),
        category: "SHIPMENT",
        priority: determineOperationalPriority({
            category: "SHIPMENT",
            readiness: summary.readiness,
            closingMatters: ["DELIVERED", "COMPLETED"].includes(row.status.toUpperCase()),
        }),
        title: "Shipment needs review",
        summary: `${label} is ${summary.readiness.toLowerCase().replace(/_/g, " ")}.`,
        entityType: "shipment",
        entityId: row.shipmentLeadId,
        entityLabel: label,
        status: summary.readiness,
        reason: summary.reviewItems[0] || summary.warnings[0] || "Operational review is required.",
        nextBestAction: "REVIEW_SHIPMENT",
        sources: summary.sources.map((s) => source(s.type, s.id, s.label)),
        blocking: summary.readiness === "NOT_READY",
        updatedAt: row.updatedAt.toISOString(),
        dedupeKey: key,
    };
}

export function lifecycleItems(
    row: ShipmentRow,
    context: ShipmentLifecycleContext
): AiOperationalItem[] {
    const label = shipmentLabel(row);
    return [...context.blockers, ...context.warnings].map((issue) => {
        const key = issue.documentSlot
            ? documentDedupeKey("shipment", row.shipmentLeadId, issue.documentSlot)
            : issue.code === "MARKET_ABOVE_P75"
              ? `shipment:${row.shipmentLeadId}:market:ABOVE_HISTORICAL_P75`
              : issue.code === "MARKET_BELOW_P25"
                ? `shipment:${row.shipmentLeadId}:market:BELOW_HISTORICAL_P25`
            : `shipment:${row.shipmentLeadId}:lifecycle:${issue.code}`;
        const nextBestAction =
            context.nextBestAction === "FOLLOW_UP_CARRIER" ||
            context.nextBestAction === "FOLLOW_UP_CUSTOMER"
                ? "FOLLOW_UP"
                : context.nextBestAction === "REVIEW_RATE"
                  ? "REVIEW_MARKET_RATE"
                  : context.nextBestAction === "REVIEW_POD"
                    ? "REVIEW_DOCUMENT"
                    : context.nextBestAction === "CHECK_TRACKING" ||
                        context.nextBestAction === "CLOSE_SHIPMENT_MANUALLY"
                      ? "REVIEW_SHIPMENT"
                      : context.nextBestAction;
        return {
            id: idFor(key),
            category: "SHIPMENT",
            priority: issue.critical ? "CRITICAL" : "MEDIUM",
            severity: issue.code,
            title: `Lifecycle: ${issue.code.toLowerCase().replace(/_/g, " ")}`,
            summary: `${label} lifecycle requires attention.`,
            entityType: "shipment",
            entityId: row.shipmentLeadId,
            entityLabel: label,
            status: context.lifecycleHealth,
            reason: issue.message,
            nextBestAction:
                nextBestAction === "REVIEW_DOCUMENT" ||
                nextBestAction === "REQUEST_DOCUMENT" ||
                nextBestAction === "FOLLOW_UP" ||
                nextBestAction === "REVIEW_COMPLIANCE" ||
                nextBestAction === "REVIEW_MARKET_RATE" ||
                nextBestAction === "REVIEW_SHIPMENT" ||
                nextBestAction === "NO_ACTION"
                    ? nextBestAction
                    : "REVIEW_SHIPMENT",
            sources: [
                source(
                    "ShipmentLifecycle",
                    row.shipmentLeadId,
                    `${context.currentStage} · ${context.lifecycleHealth}`
                ),
            ],
            blocking: issue.critical,
            updatedAt: row.updatedAt.toISOString(),
            dedupeKey: key,
        };
    });
}

export async function collectCommandCenterCandidates(
    actor: CommandCenterActor,
    myWork = false
): Promise<{ items: AiOperationalItem[]; incomplete: string[] }> {
    const incomplete: string[] = [];
    const items: AiOperationalItem[] = [];
    const shipments = await listScopedShipments(actor, myWork);
    const carriers = await listScopedCarriers(actor, shipments);

    await Promise.all(
        shipments.map(async (row) => {
            const label = shipmentLabel(row);
            const [operational, communications, market, lifecycle] = await Promise.allSettled([
                operationalAiService.shipmentSummary(actor, row.shipmentLeadId),
                communicationService.shipmentCommunications(actor, row.shipmentLeadId),
                row.carrierRate != null || row.customerRate != null
                    ? marketRateService.quote(actor, {
                          shipmentId: row.shipmentLeadId,
                          currentCarrierQuote: row.carrierRate ?? row.customerRate ?? undefined,
                      })
                    : Promise.resolve(null),
                String(process.env.AI_SHIPMENT_LIFECYCLE_ENABLED ?? "true").toLowerCase() !==
                "false"
                    ? shipmentLifecycleService.build(actor, row.shipmentLeadId)
                    : Promise.resolve(null),
            ]);
            if (operational.status === "fulfilled") {
                const summary = operational.value;
                const readiness = shipmentReadinessItem(row, summary);
                if (readiness) items.push(readiness);
                items.push(
                    ...documentItems(
                        "shipment",
                        row.shipmentLeadId,
                        label,
                        summary.documents,
                        summary.readiness,
                        ["DELIVERED", "COMPLETED"].includes(row.status.toUpperCase())
                    )
                );
                incomplete.push(...summary.incompleteContext.map((x) => `shipment:${row.shipmentLeadId}:${x}`));
            } else incomplete.push(`shipment:${row.shipmentLeadId}:operational`);

            if (communications.status === "fulfilled") {
                items.push(...communicationItems(communications.value, label));
                incomplete.push(
                    ...communications.value.incompleteContext.map(
                        (x) => `shipment:${row.shipmentLeadId}:${x}`
                    )
                );
            } else incomplete.push(`shipment:${row.shipmentLeadId}:communications`);

            if (market.status === "fulfilled" && market.value) {
                const quote = market.value;
                const assessment = quote.carrierQuoteAssessment;
                if (
                    assessment === "ABOVE_HISTORICAL_P75" ||
                    assessment === "BELOW_HISTORICAL_P25"
                ) {
                    const key = `shipment:${row.shipmentLeadId}:market:${assessment}`;
                    items.push({
                        id: idFor(key),
                        category: "MARKET",
                        priority: determineOperationalPriority({ marketAssessment: assessment }),
                        title:
                            assessment === "ABOVE_HISTORICAL_P75"
                                ? "Carrier quote above historical P75"
                                : "Carrier quote below historical P25",
                        summary: `${label} carrier quote needs market review.`,
                        entityType: "shipment",
                        entityId: row.shipmentLeadId,
                        entityLabel: label,
                        status: assessment,
                        reason: quote.comparison?.summary || assessment,
                        nextBestAction: "REVIEW_MARKET_RATE",
                        sources: quote.sources.map((s) => source(s.type, s.id, s.label)),
                        dedupeKey: key,
                    });
                }
            } else if (market.status === "rejected") {
                incomplete.push(`shipment:${row.shipmentLeadId}:market`);
            }
            if (lifecycle.status === "fulfilled" && lifecycle.value) {
                items.push(...lifecycleItems(row, lifecycle.value));
                incomplete.push(
                    ...lifecycle.value.incompleteSubsystems.map(
                        (subsystem) =>
                            `shipment:${row.shipmentLeadId}:lifecycle:${subsystem}`
                    )
                );
            } else if (lifecycle.status === "rejected") {
                incomplete.push(`shipment:${row.shipmentLeadId}:lifecycle`);
            }
        })
    );

    await Promise.all(
        carriers.map(async (carrier) => {
            const carrierId = String(carrier.carrierId);
            const label = String(carrier.legalName || carrierId);
            const [operational, communications] = await Promise.allSettled([
                operationalAiService.carrierSummary(actor, carrierId),
                communicationService.carrierCommunications(actor, carrierId),
            ]);
            if (operational.status === "fulfilled") {
                const summary = operational.value;
                items.push(
                    ...documentItems(
                        "carrier",
                        carrierId,
                        label,
                        summary.documents,
                        summary.readiness,
                        false
                    ),
                    ...mismatchItems(carrierId, label, summary)
                );
                if (summary.readiness === "NOT_READY") {
                    const key = `carrier:${carrierId}:readiness`;
                    items.push({
                        id: idFor(key),
                        category: "CARRIER",
                        priority: "HIGH",
                        title: "Carrier not ready",
                        summary: `${label} is not operationally ready.`,
                        entityType: "carrier",
                        entityId: carrierId,
                        entityLabel: label,
                        status: summary.readiness,
                        reason: summary.reviewItems[0] || summary.compliance.summary,
                        nextBestAction: "REVIEW_COMPLIANCE",
                        sources: summary.sources.map((s) => source(s.type, s.id, s.label)),
                        blocking: true,
                        dedupeKey: key,
                    });
                }
            } else incomplete.push(`carrier:${carrierId}:operational`);
            if (communications.status === "fulfilled") {
                items.push(...communicationItems(communications.value, label));
                incomplete.push(
                    ...communications.value.incompleteContext.map(
                        (x) => `carrier:${carrierId}:${x}`
                    )
                );
            } else incomplete.push(`carrier:${carrierId}:communications`);
        })
    );

    return { items, incomplete: [...new Set(incomplete)] };
}
