import { assertShipmentAccessOrThrow } from "../../../auth/access.js";
import { prisma } from "../../../config/database.js";
import { communicationService } from "../communications/index.js";
import { operationalAiService } from "../operational/index.js";
import { marketRateService } from "../rates/index.js";
import { deriveLifecycleIssues } from "./blockers.js";
import { formatShipmentLifecycleForChat } from "./format.js";
import { deriveLifecycleHealth } from "./health.js";
import { deriveNextBestAction } from "./next-action.js";
import { buildStageChecklist, buildStageHistory, deriveCurrentStage } from "./stages.js";
import type {
    LifecycleEvidence,
    LifecycleTracking,
    ShipmentLifecycleContext,
} from "./types.js";

export type LifecycleActor = { userId: string; role: string };

function enabled(): boolean {
    return String(process.env.AI_SHIPMENT_LIFECYCLE_ENABLED ?? "true").toLowerCase() !== "false";
}

async function resolveShipmentId(value: string): Promise<string> {
    const query = String(value || "").trim();
    if (!query) throw Object.assign(new Error("shipment id required"), { status: 422 });
    if (query.includes("-") && query.length >= 30) return query;
    const found = await prisma.shipmentLead.findFirst({
        where: {
            OR: [
                { loadNumber: query },
                { greenOsShipmentId: query },
                { externalShipmentId: query },
            ],
        },
        select: { shipmentLeadId: true },
    });
    if (!found) throw Object.assign(new Error("Shipment not found"), { status: 404 });
    return found.shipmentLeadId;
}

function trackingView(
    value:
        | {
              trackingId: string;
              provider: string;
              status: string;
              lastAddress: string | null;
              lastPositionAt: Date | null;
              timeLeftSec: number | null;
              distanceLeftMeters: number | null;
              driverIsLate: boolean;
          }
        | null
): LifecycleTracking {
    if (!value) return null;
    return {
        trackingId: value.trackingId,
        provider: value.provider,
        status: value.status,
        lastAddress: value.lastAddress,
        lastPositionAt: value.lastPositionAt?.toISOString() || null,
        timeLeftSec: value.timeLeftSec,
        distanceLeftMeters: value.distanceLeftMeters,
        driverIsLate: value.driverIsLate,
        complete: Boolean(
            value.lastPositionAt &&
                value.lastAddress &&
                value.timeLeftSec != null &&
                value.distanceLeftMeters != null
        ),
    };
}

export class ShipmentLifecycleService {
    async build(actor: LifecycleActor, shipmentIdOrLoadNumber: string): Promise<ShipmentLifecycleContext> {
        if (!enabled()) {
            throw Object.assign(new Error("Shipment lifecycle intelligence is disabled"), {
                status: 503,
                code: "LIFECYCLE_DISABLED",
            });
        }
        const shipmentId = await resolveShipmentId(shipmentIdOrLoadNumber);
        await assertShipmentAccessOrThrow(actor, shipmentId);
        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: shipmentId },
            select: {
                shipmentLeadId: true,
                loadNumber: true,
                greenOsShipmentId: true,
                status: true,
                customerName: true,
                customerEmail: true,
                carrierName: true,
                carrierEmail: true,
                carrierProfileId: true,
                carrierRate: true,
                customerRate: true,
                updatedAt: true,
            },
        });
        if (!lead) throw Object.assign(new Error("Shipment not found"), { status: 404 });

        const [operational, communication, market, tracking, timeline, carrierCompliance] =
            await Promise.allSettled([
                operationalAiService.shipmentSummary(actor, shipmentId),
                communicationService.shipmentCommunications(actor, shipmentId),
                lead.carrierRate != null
                    ? marketRateService.quote(actor, {
                          shipmentId,
                          currentCarrierQuote: lead.carrierRate,
                      })
                    : Promise.resolve(null),
                prisma.shipmentTracking.findFirst({
                    where: { shipmentLeadId: shipmentId, status: "ACTIVE" },
                    orderBy: { updatedAt: "desc" },
                    select: {
                        trackingId: true,
                        provider: true,
                        status: true,
                        lastAddress: true,
                        lastPositionAt: true,
                        timeLeftSec: true,
                        distanceLeftMeters: true,
                        driverIsLate: true,
                    },
                }),
                Promise.all([
                    prisma.domainEvent.findMany({
                        where: { shipmentLeadId: shipmentId },
                        orderBy: { createdAt: "asc" },
                        take: 100,
                        select: {
                            eventId: true,
                            eventType: true,
                            title: true,
                            createdAt: true,
                        },
                    }),
                    prisma.shipmentTimelineEvent.findMany({
                        where: { shipmentLeadId: shipmentId },
                        orderBy: { createdAt: "asc" },
                        take: 100,
                        select: { eventId: true, stage: true, title: true, createdAt: true },
                    }),
                ]),
                lead.carrierProfileId
                    ? operationalAiService.carrierSummary(actor, lead.carrierProfileId)
                    : Promise.resolve(null),
            ]);

        const incompleteSubsystems: string[] = [];
        if (operational.status === "rejected") incompleteSubsystems.push("operational");
        if (communication.status === "rejected") incompleteSubsystems.push("communication");
        if (market.status === "rejected") incompleteSubsystems.push("market");
        if (tracking.status === "rejected") incompleteSubsystems.push("tracking");
        if (timeline.status === "rejected") incompleteSubsystems.push("timeline");
        if (carrierCompliance.status === "rejected") incompleteSubsystems.push("carrier_compliance");

        const ops = operational.status === "fulfilled" ? operational.value : null;
        const comm = communication.status === "fulfilled" ? communication.value : null;
        const quote = market.status === "fulfilled" ? market.value : null;
        const carrierOps =
            carrierCompliance.status === "fulfilled" ? carrierCompliance.value : null;
        const trackingData =
            tracking.status === "fulfilled" ? trackingView(tracking.value) : null;
        const timelineRows =
            timeline.status === "fulfilled"
                ? [
                      ...timeline.value[0].map((event) => ({
                          at: event.createdAt.toISOString(),
                          title: event.title,
                          type: event.eventType,
                          id: event.eventId,
                      })),
                      ...timeline.value[1].map((event) => ({
                          at: event.createdAt.toISOString(),
                          title: event.title,
                          type: event.stage,
                          id: event.eventId,
                      })),
                  ].sort((a, b) => a.at.localeCompare(b.at))
                : [];

        const documents = ops?.documents || [];
        const closeoutReadiness = ops?.readiness || "INCOMPLETE";
        const evidence: LifecycleEvidence = {
            status: lead.status,
            documents,
            carrierCompliance: carrierOps
                ? {
                      readiness: carrierOps.readiness,
                      light: carrierOps.compliance.light,
                  }
                : undefined,
            ratePresent: lead.carrierRate != null,
            communication: comm,
            tracking: trackingData,
            closeoutReadiness,
            marketAssessment: quote?.carrierQuoteAssessment || null,
            incompleteSubsystems,
        };
        const currentStage = deriveCurrentStage(evidence);
        if (
            ["PICKUP", "IN_TRANSIT", "DELIVERY"].includes(currentStage) &&
            (!trackingData || !trackingData.complete)
        ) {
            incompleteSubsystems.push("tracking_data");
        }
        const issues = deriveLifecycleIssues(evidence, currentStage);
        const lifecycleHealth = deriveLifecycleHealth({
            blockers: issues.blockers,
            warnings: issues.warnings,
            incompleteSubsystems,
            insufficientCoreData: !ops,
        });
        const stages = buildStageChecklist(evidence);
        const nextBestAction = deriveNextBestAction({
            stage: currentStage,
            evidence,
            blockers: issues.blockers,
            warnings: issues.warnings,
        });
        const allSources = [
            ...(ops?.sources || []),
            ...(carrierOps?.sources || []),
            ...(comm?.sources || []).map((source) => ({
                type: source.type,
                id: source.id,
                label: source.label,
                shipmentLeadId: shipmentId,
            })),
        ];
        const sourceKeys = new Set<string>();
        const sources = allSources.filter((source) => {
            const key = `${source.type}:${source.id}`;
            if (sourceKeys.has(key)) return false;
            sourceKeys.add(key);
            return true;
        });

        return {
            shipmentId,
            loadNumber: lead.loadNumber || lead.greenOsShipmentId,
            currentStage,
            stageStatus:
                stages.find((stage) => stage.stage === currentStage)?.progress || "INCOMPLETE",
            progress:
                stages.find((stage) => stage.stage === currentStage)?.progress || "INCOMPLETE",
            lifecycleHealth,
            closeoutReadiness,
            stageHistory: buildStageHistory(timelineRows),
            stages,
            blockers: issues.blockers,
            warnings: issues.warnings,
            missingItems: documents
                .filter((document) => document.status === "MISSING")
                .map((document) => document.slot),
            completedItems: stages
                .filter((stage) => stage.progress === "COMPLETE")
                .map((stage) => stage.stage),
            pendingItems: stages
                .filter((stage) =>
                    ["PENDING", "IN_PROGRESS", "BLOCKED"].includes(stage.progress)
                )
                .map((stage) => stage.stage),
            carrier: {
                ...(ops?.carrier || {}),
                name: lead.carrierName,
                email: lead.carrierEmail,
                complianceReadiness: carrierOps?.readiness || null,
                complianceLight: carrierOps?.compliance.light || null,
            },
            customer: { name: lead.customerName, email: lead.customerEmail },
            rate: {
                customerRate: lead.customerRate,
                carrierRate: lead.carrierRate,
                assessment: quote?.carrierQuoteAssessment || null,
                internalTarget: quote?.recommendedTarget || null,
                provider: quote?.provider || "InternalHistoricalRateProvider",
                dat: "NOT_CONNECTED",
                truckstop: "NOT_CONNECTED",
            },
            documents,
            communication: comm
                ? {
                      communicationStatus: comm.communicationStatus,
                      waitingFor: comm.waitingFor,
                      waitingSince: comm.waitingSince,
                      followUp: comm.followUp,
                      recommendations: comm.recommendations,
                      lastContact: comm.lastContact,
                  }
                : null,
            tracking: trackingData,
            timeline: timelineRows,
            nextBestAction,
            sources,
            incompleteSubsystems: [...new Set(incompleteSubsystems)],
            generatedAt: new Date().toISOString(),
            groundingLabel: "Based on GreenOS lifecycle data",
        };
    }

    formatForChat(context: ShipmentLifecycleContext): string {
        return formatShipmentLifecycleForChat(context);
    }
}

export const shipmentLifecycleService = new ShipmentLifecycleService();

export const _lifecycleTestUtils = {
    deriveCurrentStage,
    buildStageChecklist,
    buildStageHistory,
    deriveLifecycleIssues,
    deriveLifecycleHealth,
    deriveNextBestAction,
    trackingView,
};
