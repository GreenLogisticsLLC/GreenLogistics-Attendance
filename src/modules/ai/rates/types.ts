export type RateActor = { userId: string; role: string };

export type ComparisonLevel = "EXACT_ZIP_LANE" | "LANE_EQUIPMENT" | "REGIONAL";

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

export type MarketRateStatus =
    | "OK"
    | "INSUFFICIENT_DATA"
    | "MISSING_MILES"
    | "NOT_FOUND"
    | "FORBIDDEN";

export type CarrierQuoteAssessment =
    | "ABOVE_HISTORICAL_P75"
    | "BELOW_HISTORICAL_P25"
    | "WITHIN_HISTORICAL_RANGE";

export type HistoricalRateRecord = {
    shipmentId: string;
    loadNumber: string | null;
    origin: string;
    destination: string;
    originZip: string | null;
    destinationZip: string | null;
    originCity: string | null;
    originState: string | null;
    destinationCity: string | null;
    destinationState: string | null;
    originRegion: string | null;
    destinationRegion: string | null;
    equipment: string | null;
    equipmentCategory: string;
    miles: number;
    weight: string | null;
    rate: number;
    rpm: number;
    pickupDate: string | null;
    deliveryDate: string | null;
    carrierId: string | null;
    status: string;
};

export type RateStatistics = {
    count: number;
    min: number;
    max: number;
    average: number;
    median: number;
    p25: number;
    p75: number;
};

export type MarketRateRequest = {
    shipmentId?: string;
    origin?: string;
    destination?: string;
    originZip?: string;
    destinationZip?: string;
    originCity?: string;
    originState?: string;
    destinationCity?: string;
    destinationState?: string;
    equipment?: string;
    miles?: number;
    weight?: string;
    pickupDate?: string;
    deliveryDate?: string;
    currentCarrierQuote?: number;
};

export type MarketRateSource = {
    type: "shipment";
    id: string;
    label: string;
};

export type MarketRateResult = {
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
};

/** Alias — Phase 5A internal quote shape. */
export type InternalMarketRateQuote = MarketRateResult;
