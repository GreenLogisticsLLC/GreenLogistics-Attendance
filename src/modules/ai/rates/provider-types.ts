import type {
    CarrierQuoteAssessment,
    ComparisonLevel,
    ConfidenceLevel,
    MarketRateSource,
    MarketRateStatus,
    RateStatistics,
} from "./types.js";

/** GreenOS market-rate provider identifiers. */
export type MarketRateProviderId = "INTERNAL_HISTORICAL" | "DAT" | "TRUCKSTOP";

/** Provider lifecycle — distinct from quote/data status. */
export type ProviderLifecycleStatus =
    | "NOT_CONFIGURED"
    | "CONFIGURED"
    | "AVAILABLE"
    | "UNAVAILABLE"
    | "ERROR"
    | "TIMEOUT";

/** Normalized external/provider error codes. */
export type ProviderErrorCode =
    | "NOT_CONFIGURED"
    | "AUTHENTICATION_ERROR"
    | "AUTHORIZATION_ERROR"
    | "RATE_LIMITED"
    | "TIMEOUT"
    | "BAD_REQUEST"
    | "PROVIDER_ERROR"
    | "INVALID_RESPONSE"
    | "UNAVAILABLE";

export type RawAvailability = "DATA" | "NO_DATA" | "NOT_CONNECTED" | "ERROR";

export type ExternalConfidence = ConfidenceLevel | "UNKNOWN" | "NOT_PROVIDED";

export type NormalizedRateRange = {
    low: number | null;
    high: number | null;
    median: number | null;
    p25: number | null;
    p75: number | null;
};

export type MarketRateSourceKind = "GREENOS_INTERNAL" | "DAT" | "TRUCKSTOP";

/**
 * Normalized per-provider quote — common fields only.
 * Provider-specific fields stay in providerMetadata.
 */
export type NormalizedProviderQuote = {
    providerId: MarketRateProviderId;
    providerName: string;
    source: MarketRateSourceKind;
    lifecycleStatus: ProviderLifecycleStatus;
    errorCode: ProviderErrorCode | null;
    errorMessage: string | null;
    origin: string | null;
    destination: string | null;
    equipment: string | null;
    miles: number | null;
    currency: "USD";
    rate: number | null;
    rpm: number | null;
    rateRange: NormalizedRateRange | null;
    sampleSize: number | null;
    confidence: ExternalConfidence | null;
    retrievedAt: string;
    providerTimestamp: string | null;
    expirationAt: string | null;
    sourceReference: string | null;
    rawAvailability: RawAvailability;
    /** Isolated provider-specific payload — never merged into common stats blindly. */
    providerMetadata: Record<string, unknown>;
};

export type ExternalMarketSummary = {
    retrievedAt: string;
    providersWithData: MarketRateProviderId[];
    rateRange: NormalizedRateRange | null;
    rpmRange: { low: number | null; high: number | null; median: number | null } | null;
    confidence: ExternalConfidence;
};

export type CombinedMarketView = {
    retrievedAt: string;
    internalHistoricalTarget: number | null;
    externalRateRange: NormalizedRateRange | null;
    note: string;
};

export type BenchmarkComparison = {
    carrierQuote: number | null;
    vsInternalHistorical: CarrierQuoteAssessment | null;
    vsDat: "ABOVE" | "BELOW" | "WITHIN" | "UNAVAILABLE" | null;
    vsTruckstop: "ABOVE" | "BELOW" | "WITHIN" | "UNAVAILABLE" | null;
    summary: string | null;
};

/** Phase 5A internal detail preserved for backward compatibility. */
export type InternalHistoricalDetail = {
    comparisonLevel: ComparisonLevel | null;
    sampleSize: number;
    rpm: RateStatistics | null;
    rate: RateStatistics | null;
    recommendedTarget: number | null;
    recommendedTargetLabel: "INTERNAL HISTORICAL TARGET";
    confidence: ConfidenceLevel | null;
    historicalDataDateRange: { earliest: string | null; latest: string | null };
    sources: MarketRateSource[];
    recencyNote: string | null;
};

/**
 * Composite engine response — extends Phase 5A top-level fields from internal historical.
 */
export type MarketRateCompositeResult = {
    status: MarketRateStatus;
    source: "GREENOS_INTERNAL_HISTORY";
    provider: string;
    comparisonLevel: ComparisonLevel | null;
    sampleSize: number;
    miles: number | null;
    rpm: RateStatistics | null;
    rate: RateStatistics | null;
    recommendedTarget: number | null;
    recommendedTargetLabel: "INTERNAL HISTORICAL TARGET";
    confidence: ConfidenceLevel | null;
    historicalDataDateRange: { earliest: string | null; latest: string | null };
    sources: MarketRateSource[];
    carrierQuote: number | null;
    carrierQuoteAssessment: CarrierQuoteAssessment | null;
    recencyNote: string | null;
    message: string | null;
    retrievedAt: string;
    answerMode: "internal_market" | "external_market" | "market_comparison";
    providers: NormalizedProviderQuote[];
    providerStatuses: Record<MarketRateProviderId, ProviderLifecycleStatus>;
    internalHistorical: NormalizedProviderQuote | null;
    internalHistoricalDetail: InternalHistoricalDetail | null;
    externalMarket: ExternalMarketSummary | null;
    combinedView: CombinedMarketView | null;
    comparison: BenchmarkComparison | null;
};

export type ProviderRunContext = {
    retrievedAt: string;
    timeoutMs: number;
    retryCount: number;
};
