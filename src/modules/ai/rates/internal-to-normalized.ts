import type { MarketRateResult } from "./types.js";
import type { NormalizedProviderQuote } from "./provider-types.js";

export function mapInternalResultToNormalized(
    result: MarketRateResult,
    retrievedAt: string
): NormalizedProviderQuote {
    const hasData = result.status === "OK" || result.status === "MISSING_MILES";
    const lifecycleStatus =
        result.status === "FORBIDDEN" || result.status === "NOT_FOUND"
            ? "UNAVAILABLE"
            : hasData && result.sampleSize > 0
              ? "AVAILABLE"
              : result.status === "INSUFFICIENT_DATA"
                ? "AVAILABLE"
                : "UNAVAILABLE";

    return {
        providerId: "INTERNAL_HISTORICAL",
        providerName: "InternalHistoricalRateProvider",
        source: "GREENOS_INTERNAL",
        lifecycleStatus,
        errorCode:
            result.status === "FORBIDDEN"
                ? "AUTHORIZATION_ERROR"
                : result.status === "NOT_FOUND"
                  ? "UNAVAILABLE"
                  : null,
        errorMessage: result.message,
        origin: null,
        destination: null,
        equipment: null,
        miles: result.miles,
        currency: "USD",
        rate: result.recommendedTarget,
        rpm: result.rpm?.median ?? null,
        rateRange: result.rate
            ? {
                  low: result.rate.min,
                  high: result.rate.max,
                  median: result.rate.median,
                  p25: result.rate.p25,
                  p75: result.rate.p75,
              }
            : null,
        sampleSize: result.sampleSize || null,
        confidence: result.confidence,
        retrievedAt,
        providerTimestamp: result.historicalDataDateRange.latest,
        expirationAt: null,
        sourceReference: "GREENOS_INTERNAL_HISTORY",
        rawAvailability: hasData && result.sampleSize > 0 ? "DATA" : "NO_DATA",
        providerMetadata: {
            comparisonLevel: result.comparisonLevel,
            recencyNote: result.recencyNote,
            historicalDataDateRange: result.historicalDataDateRange,
            carrierQuoteAssessment: result.carrierQuoteAssessment,
        },
    };
}

export function extractInternalHistoricalDetail(result: MarketRateResult) {
    if (result.status !== "OK" && result.status !== "MISSING_MILES") return null;
    return {
        comparisonLevel: result.comparisonLevel,
        sampleSize: result.sampleSize,
        rpm: result.rpm,
        rate: result.rate,
        recommendedTarget: result.recommendedTarget,
        recommendedTargetLabel: result.recommendedTargetLabel,
        confidence: result.confidence,
        historicalDataDateRange: result.historicalDataDateRange,
        sources: result.sources,
        recencyNote: result.recencyNote,
    };
}
