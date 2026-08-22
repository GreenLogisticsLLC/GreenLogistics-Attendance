import { prisma } from "../../../config/database.js";
import { assertShipmentAccessOrThrow } from "../../../auth/access.js";
import {
    buildHistoricalAclWhere,
    HISTORICAL_FETCH_LIMIT,
    SHIPMENT_RATE_SELECT,
} from "./acl-scope.js";
import {
    applyRecencyConfidence,
    computeTargetFromRpm,
    computeTargetRate,
    confidenceFromSampleSize,
} from "./confidence.js";
import { buildQueryContext, findComparables } from "./comparables.js";
import { mapToHistoricalRecord, parseMoneyQuote } from "./historical-record.js";
import { computeRateStatistics, roundDisplay, roundRateStats } from "./statistics.js";
import type {
    CarrierQuoteAssessment,
    MarketRateRequest,
    MarketRateResult,
    MarketRateSource,
    RateActor,
} from "./types.js";
import type { MarketRateProvider } from "./provider-interface.js";
import type { ProviderLifecycleStatus, ProviderRunContext } from "./provider-types.js";
import { mapInternalResultToNormalized } from "./internal-to-normalized.js";

function assessCarrierQuote(
    quote: number,
    rateStats: { p25: number; p75: number }
): CarrierQuoteAssessment {
    if (quote > rateStats.p75) return "ABOVE_HISTORICAL_P75";
    if (quote < rateStats.p25) return "BELOW_HISTORICAL_P25";
    return "WITHIN_HISTORICAL_RANGE";
}

function buildSources(records: { shipmentId: string; loadNumber: string | null }[]): MarketRateSource[] {
    return records.slice(0, 50).map((r) => ({
        type: "shipment" as const,
        id: r.shipmentId,
        label: r.loadNumber ? `Shipment ${r.loadNumber}` : `Shipment ${r.shipmentId.slice(0, 8)}`,
    }));
}

function dateRange(records: { pickupDate: string | null }[]): {
    earliest: string | null;
    latest: string | null;
} {
    const dates = records
        .map((r) => r.pickupDate)
        .filter((d): d is string => Boolean(d))
        .sort();
    if (!dates.length) return { earliest: null, latest: null };
    return { earliest: dates[0], latest: dates[dates.length - 1] };
}

async function resolveShipmentContext(
    actor: RateActor,
    shipmentId: string
): Promise<{
    request: MarketRateRequest;
    excludeShipmentId: string;
} | null> {
    let id = String(shipmentId || "").trim();
    if (!id.includes("-") || id.length < 30) {
        const byNumber = await prisma.shipmentLead.findFirst({
            where: {
                OR: [{ loadNumber: id }, { greenOsShipmentId: id }, { externalShipmentId: id }],
            },
            select: { shipmentLeadId: true },
        });
        if (byNumber) id = byNumber.shipmentLeadId;
    }

    await assertShipmentAccessOrThrow(actor, id);

    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: id },
        select: {
            shipmentLeadId: true,
            pickupCity: true,
            pickupState: true,
            pickupZip: true,
            deliveryCity: true,
            deliveryState: true,
            deliveryZip: true,
            equipment: true,
            miles: true,
            weight: true,
            pickupFrom: true,
            carrierRate: true,
        },
    });
    if (!lead) return null;

    return {
        excludeShipmentId: lead.shipmentLeadId,
        request: {
            originCity: lead.pickupCity || undefined,
            originState: lead.pickupState || undefined,
            originZip: lead.pickupZip || undefined,
            destinationCity: lead.deliveryCity || undefined,
            destinationState: lead.deliveryState || undefined,
            destinationZip: lead.deliveryZip || undefined,
            equipment: lead.equipment || undefined,
            miles: lead.miles ?? undefined,
            weight: lead.weight || undefined,
            pickupDate: lead.pickupFrom ? lead.pickupFrom.toISOString() : undefined,
            currentCarrierQuote: lead.carrierRate ?? undefined,
        },
    };
}

function insufficient(message: string): MarketRateResult {
    return {
        status: "INSUFFICIENT_DATA",
        source: "GREENOS_INTERNAL_HISTORY",
        provider: "InternalHistoricalRateProvider",
        comparisonLevel: null,
        sampleSize: 0,
        miles: null,
        rpm: null,
        rate: null,
        recommendedTarget: null,
        recommendedTargetLabel: "INTERNAL HISTORICAL TARGET",
        confidence: null,
        historicalDataDateRange: { earliest: null, latest: null },
        sources: [],
        carrierQuote: null,
        carrierQuoteAssessment: null,
        recencyNote: null,
        message,
    };
}

export class InternalHistoricalRateProvider implements MarketRateProvider {
    readonly id = "INTERNAL_HISTORICAL" as const;
    readonly name = "InternalHistoricalRateProvider";

    getLifecycleStatus(): ProviderLifecycleStatus {
        return "AVAILABLE";
    }

    async getMarketRate(
        actor: RateActor,
        request: MarketRateRequest,
        context: ProviderRunContext
    ) {
        const result = await this.quote(actor, request);
        return mapInternalResultToNormalized(result, context.retrievedAt);
    }

    /** Phase 5A internal quote — unchanged logic. */
    async quote(actor: RateActor, request: MarketRateRequest): Promise<MarketRateResult> {
        let effective = { ...request };
        let excludeShipmentId: string | undefined;

        if (request.shipmentId) {
            try {
                const resolved = await resolveShipmentContext(actor, request.shipmentId);
                if (!resolved) {
                    return {
                        ...insufficient("Shipment not found"),
                        status: "NOT_FOUND",
                    };
                }
                excludeShipmentId = resolved.excludeShipmentId;
                effective = {
                    ...resolved.request,
                    ...request,
                    shipmentId: request.shipmentId,
                    currentCarrierQuote:
                        request.currentCarrierQuote ?? resolved.request.currentCarrierQuote,
                };
            } catch (err) {
                const status =
                    err && typeof err === "object" && "status" in err
                        ? Number((err as { status: number }).status)
                        : 500;
                if (status === 403) {
                    return {
                        ...insufficient("Access denied"),
                        status: "FORBIDDEN",
                    };
                }
                if (status === 404) {
                    return {
                        ...insufficient("Shipment not found"),
                        status: "NOT_FOUND",
                    };
                }
                throw err;
            }
        }

        const queryMiles =
            effective.miles != null && Number.isFinite(Number(effective.miles))
                ? Number(effective.miles)
                : null;

        const query = buildQueryContext(effective);

        if (request.shipmentId && queryMiles == null) {
            const aclWhere = await buildHistoricalAclWhere(actor);
            const rows = await prisma.shipmentLead.findMany({
                where: aclWhere,
                select: SHIPMENT_RATE_SELECT,
                orderBy: { pickupFrom: "desc" },
                take: HISTORICAL_FETCH_LIMIT,
            });
            const dataset = rows
                .map(mapToHistoricalRecord)
                .filter((r): r is NonNullable<typeof r> => r != null);
            const match = findComparables(query, dataset, excludeShipmentId);
            if (!match || !match.records.length) {
                return {
                    ...insufficient(
                        "Insufficient GreenOS historical data to calculate a reliable estimate"
                    ),
                    status: "MISSING_MILES",
                    miles: null,
                };
            }
            const rates = match.records.map((r) => r.rate);
            const rateStats = roundRateStats(computeRateStatistics(rates)!);
            return {
                status: "MISSING_MILES",
                source: "GREENOS_INTERNAL_HISTORY",
                provider: this.name,
                comparisonLevel: match.level,
                sampleSize: match.records.length,
                miles: null,
                rpm: null,
                rate: rateStats,
                recommendedTarget: roundDisplay(computeTargetRate(rates)!),
                recommendedTargetLabel: "INTERNAL HISTORICAL TARGET",
                confidence: confidenceFromSampleSize(match.records.length),
                historicalDataDateRange: dateRange(match.records),
                sources: buildSources(match.records),
                carrierQuote: parseMoneyQuote(effective.currentCarrierQuote),
                carrierQuoteAssessment: null,
                recencyNote: "Shipment miles missing — RPM not calculated",
                message: "Missing miles — cannot calculate RPM from GreenOS data",
            };
        }

        if (!query.cityStateLaneKey && !query.zipLaneKey) {
            return insufficient(
                "Insufficient lane information — origin and destination city/state or ZIP required"
            );
        }

        const aclWhere = await buildHistoricalAclWhere(actor);
        const rows = await prisma.shipmentLead.findMany({
            where: aclWhere,
            select: SHIPMENT_RATE_SELECT,
            orderBy: { pickupFrom: "desc" },
            take: HISTORICAL_FETCH_LIMIT,
        });

        const dataset = rows
            .map(mapToHistoricalRecord)
            .filter((r): r is NonNullable<typeof r> => r != null);

        const match = findComparables(query, dataset, excludeShipmentId);
        if (!match || !match.records.length) {
            return insufficient(
                "Insufficient GreenOS historical data to calculate a reliable estimate"
            );
        }

        const rates = match.records.map((r) => r.rate);
        const rpms = match.records.map((r) => r.rpm);
        const rateStatsRaw = computeRateStatistics(rates)!;
        const rpmStatsRaw = computeRateStatistics(rpms)!;
        const rateStats = roundRateStats(rateStatsRaw);
        const rpmStats = roundRateStats(rpmStatsRaw);

        let baseConfidence = confidenceFromSampleSize(match.records.length);
        const { confidence, recencyNote } = applyRecencyConfidence(baseConfidence, match.records);

        let recommendedTarget = computeTargetRate(rates);
        if (recommendedTarget != null && queryMiles != null && queryMiles > 0) {
            recommendedTarget = roundDisplay(computeTargetFromRpm(rpmStatsRaw.median, queryMiles));
        } else if (recommendedTarget != null) {
            recommendedTarget = roundDisplay(recommendedTarget);
        }

        const carrierQuote = parseMoneyQuote(effective.currentCarrierQuote);
        let carrierQuoteAssessment: CarrierQuoteAssessment | null = null;
        if (carrierQuote != null) {
            carrierQuoteAssessment = assessCarrierQuote(carrierQuote, rateStats);
        }

        return {
            status: "OK",
            source: "GREENOS_INTERNAL_HISTORY",
            provider: this.name,
            comparisonLevel: match.level,
            sampleSize: match.records.length,
            miles: queryMiles,
            rpm: rpmStats,
            rate: rateStats,
            recommendedTarget,
            recommendedTargetLabel: "INTERNAL HISTORICAL TARGET",
            confidence,
            historicalDataDateRange: dateRange(match.records),
            sources: buildSources(match.records),
            carrierQuote,
            carrierQuoteAssessment,
            recencyNote,
            message: null,
        };
    }
}

export const internalHistoricalRateProvider = new InternalHistoricalRateProvider();
