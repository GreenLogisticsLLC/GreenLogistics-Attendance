import type { CarrierQuoteAssessment, MarketRateResult } from "./types.js";
import type {
    BenchmarkComparison,
    CombinedMarketView,
    ExternalMarketSummary,
    MarketRateCompositeResult,
    MarketRateProviderId,
    NormalizedProviderQuote,
    ProviderLifecycleStatus,
} from "./provider-types.js";
import {
    extractInternalHistoricalDetail,
    mapInternalResultToNormalized,
} from "./internal-to-normalized.js";

function compareQuoteToRange(
    quote: number,
    range: { p25: number; p75: number } | null
): "ABOVE" | "BELOW" | "WITHIN" | "UNAVAILABLE" {
    if (!range) return "UNAVAILABLE";
    if (quote > range.p75) return "ABOVE";
    if (quote < range.p25) return "BELOW";
    return "WITHIN";
}

function externalProvidersWithData(providers: NormalizedProviderQuote[]): MarketRateProviderId[] {
    return providers
        .filter(
            (p) =>
                (p.providerId === "DAT" || p.providerId === "TRUCKSTOP") &&
                p.lifecycleStatus === "AVAILABLE" &&
                p.rawAvailability === "DATA" &&
                p.rate != null
        )
        .map((p) => p.providerId);
}

function buildExternalSummary(
    providers: NormalizedProviderQuote[],
    retrievedAt: string
): ExternalMarketSummary | null {
    const external = providers.filter(
        (p) =>
            (p.providerId === "DAT" || p.providerId === "TRUCKSTOP") &&
            p.lifecycleStatus === "AVAILABLE" &&
            p.rawAvailability === "DATA"
    );
    if (!external.length) return null;

    const rates = external.map((p) => p.rate).filter((r): r is number => r != null);
    const rpms = external.map((p) => p.rpm).filter((r): r is number => r != null);
    if (!rates.length) return null;

    const sortedRates = [...rates].sort((a, b) => a - b);
    const sortedRpms = [...rpms].sort((a, b) => a - b);

    return {
        retrievedAt,
        providersWithData: externalProvidersWithData(providers),
        rateRange: {
            low: sortedRates[0],
            high: sortedRates[sortedRates.length - 1],
            median: sortedRates[Math.floor(sortedRates.length / 2)],
            p25: sortedRates[0],
            p75: sortedRates[sortedRates.length - 1],
        },
        rpmRange: sortedRpms.length
            ? {
                  low: sortedRpms[0],
                  high: sortedRpms[sortedRpms.length - 1],
                  median: sortedRpms[Math.floor(sortedRpms.length / 2)],
              }
            : null,
        confidence: "UNKNOWN",
    };
}

function resolveAnswerMode(
    internal: MarketRateResult,
    providers: NormalizedProviderQuote[]
): MarketRateCompositeResult["answerMode"] {
    const externalData = externalProvidersWithData(providers);
    const internalHasData = internal.status === "OK" && internal.sampleSize > 0;
    if (internalHasData && externalData.length) return "market_comparison";
    if (externalData.length) return "external_market";
    return "internal_market";
}

function buildComparison(
    internal: MarketRateResult,
    providers: NormalizedProviderQuote[]
): BenchmarkComparison | null {
    const quote = internal.carrierQuote;
    if (quote == null) return null;

    const dat = providers.find((p) => p.providerId === "DAT");
    const truckstop = providers.find((p) => p.providerId === "TRUCKSTOP");

    const vsDat = compareQuoteToRange(
        quote,
        dat?.rateRange?.p25 != null && dat.rateRange.p75 != null
            ? { p25: dat.rateRange.p25, p75: dat.rateRange.p75 }
            : dat?.rate != null
              ? { p25: dat.rate, p75: dat.rate }
              : null
    );
    const vsTruckstop = compareQuoteToRange(
        quote,
        truckstop?.rateRange?.p25 != null && truckstop.rateRange.p75 != null
            ? { p25: truckstop.rateRange.p25, p75: truckstop.rateRange.p75 }
            : truckstop?.rate != null
              ? { p25: truckstop.rate, p75: truckstop.rate }
              : null
    );

    const parts: string[] = [];
    if (internal.carrierQuoteAssessment) {
        parts.push(`GreenOS historical: ${internal.carrierQuoteAssessment}`);
    }
    if (vsDat !== "UNAVAILABLE") parts.push(`DAT: ${vsDat}`);
    if (vsTruckstop !== "UNAVAILABLE") parts.push(`Truckstop: ${vsTruckstop}`);

    return {
        carrierQuote: quote,
        vsInternalHistorical: internal.carrierQuoteAssessment,
        vsDat,
        vsTruckstop,
        summary: parts.length ? parts.join("; ") : null,
    };
}

export function buildMarketRateCompositeResult(input: {
    internal: MarketRateResult;
    providerQuotes: NormalizedProviderQuote[];
    retrievedAt: string;
}): MarketRateCompositeResult {
    const { internal, providerQuotes, retrievedAt } = input;

    const providerStatuses = providerQuotes.reduce(
        (acc, p) => {
            acc[p.providerId] = p.lifecycleStatus;
            return acc;
        },
        {} as Record<MarketRateProviderId, ProviderLifecycleStatus>
    );

    for (const id of ["INTERNAL_HISTORICAL", "DAT", "TRUCKSTOP"] as MarketRateProviderId[]) {
        if (!providerStatuses[id]) providerStatuses[id] = "NOT_CONFIGURED";
    }

    const internalNormalized =
        providerQuotes.find((p) => p.providerId === "INTERNAL_HISTORICAL") ??
        mapInternalResultToNormalized(internal, retrievedAt);

    const externalMarket = buildExternalSummary(providerQuotes, retrievedAt);
    const answerMode = resolveAnswerMode(internal, providerQuotes);

    return {
        ...internal,
        retrievedAt,
        answerMode,
        providers: providerQuotes,
        providerStatuses,
        internalHistorical: internalNormalized,
        internalHistoricalDetail: extractInternalHistoricalDetail(internal),
        externalMarket,
        combinedView: externalMarket
            ? {
                  retrievedAt,
                  internalHistoricalTarget: internal.recommendedTarget,
                  externalRateRange: externalMarket.rateRange,
                  note: "Internal historical and external provider values are reported separately — not blended into one unexplained number.",
              }
            : null,
        comparison: buildComparison(internal, providerQuotes),
    };
}

export const _aggregationTestUtils = {
    buildExternalSummary,
    externalProvidersWithData,
    compareQuoteToRange,
};
