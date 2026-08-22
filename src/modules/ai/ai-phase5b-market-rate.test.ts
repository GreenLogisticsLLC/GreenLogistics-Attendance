import test from "node:test";
import assert from "node:assert/strict";
import { MarketRateEngine } from "./rates/market-rate-engine.js";
import { createTestRegistry } from "./rates/provider-registry.js";
import { internalHistoricalRateProvider } from "./rates/internal-historical-provider.js";
import { datMarketRateProvider } from "./rates/dat-market-rate-provider.js";
import { truckstopMarketRateProvider } from "./rates/truckstop-market-rate-provider.js";
import type { MarketRateProvider } from "./rates/provider-interface.js";
import type { MarketRateRequest, RateActor } from "./rates/types.js";
import type {
    NormalizedProviderQuote,
    ProviderLifecycleStatus,
    ProviderRunContext,
} from "./rates/provider-types.js";
import { getMarketRateConfigForStatus } from "./rates/market-rate-config.js";
import { buildMarketRateCompositeResult } from "./rates/aggregation.js";
import { mapInternalResultToNormalized } from "./rates/internal-to-normalized.js";
import type { MarketRateResult } from "./rates/types.js";

const actor: RateActor = { userId: "u-test", role: "Administrator" };
const request: MarketRateRequest = {
    originCity: "Los Angeles",
    originState: "CA",
    originZip: "90001",
    destinationCity: "Dallas",
    destinationState: "TX",
    destinationZip: "75201",
    equipment: "Dry Van",
    miles: 1500,
};

function mockProvider(
    id: "DAT" | "TRUCKSTOP",
    name: string,
    lifecycleStatus: ProviderLifecycleStatus,
    quote: Partial<NormalizedProviderQuote>
): MarketRateProvider {
    return {
        id,
        name,
        getLifecycleStatus: () => lifecycleStatus,
        getMarketRate: async (_actor, _req, ctx: ProviderRunContext) => ({
            providerId: id,
            providerName: name,
            source: id,
            lifecycleStatus,
            errorCode: quote.errorCode ?? null,
            errorMessage: quote.errorMessage ?? null,
            origin: "LOS ANGELES, CA",
            destination: "DALLAS, TX",
            equipment: "DRY_VAN",
            miles: 1500,
            currency: "USD",
            rate: quote.rate ?? null,
            rpm: quote.rpm ?? null,
            rateRange: quote.rateRange ?? null,
            sampleSize: quote.sampleSize ?? null,
            confidence: quote.confidence ?? "UNKNOWN",
            retrievedAt: ctx.retrievedAt,
            providerTimestamp: ctx.retrievedAt,
            expirationAt: null,
            sourceReference: quote.sourceReference ?? id,
            rawAvailability: quote.rawAvailability ?? "NO_DATA",
            providerMetadata: quote.providerMetadata ?? {},
        }),
    };
}

function minimalInternalResult(overrides: Partial<MarketRateResult> = {}): MarketRateResult {
    return {
        status: "OK",
        source: "GREENOS_INTERNAL_HISTORY",
        provider: "InternalHistoricalRateProvider",
        comparisonLevel: "EXACT_ZIP_LANE",
        sampleSize: 5,
        miles: 1500,
        rpm: { count: 5, min: 1.8, max: 2.2, average: 2, median: 2, p25: 1.9, p75: 2.1 },
        rate: { count: 5, min: 2700, max: 3300, average: 3000, median: 3000, p25: 2850, p75: 3150 },
        recommendedTarget: 3000,
        recommendedTargetLabel: "INTERNAL HISTORICAL TARGET",
        confidence: "MEDIUM",
        historicalDataDateRange: { earliest: "2025-01-01", latest: "2025-06-01" },
        sources: [{ type: "shipment", id: "s1", label: "Shipment GL100" }],
        carrierQuote: 3600,
        carrierQuoteAssessment: "ABOVE_HISTORICAL_P75",
        recencyNote: null,
        message: null,
        ...overrides,
    };
}

test("Phase 5B: DAT stub is NOT_CONFIGURED", () => {
    assert.equal(datMarketRateProvider.getLifecycleStatus(), "NOT_CONFIGURED");
});

test("Phase 5B: Truckstop stub is NOT_CONFIGURED", () => {
    assert.equal(truckstopMarketRateProvider.getLifecycleStatus(), "NOT_CONFIGURED");
});

test("Phase 5B: config snapshot never exposes secret values", () => {
    const snap = getMarketRateConfigForStatus();
    assert.equal(typeof snap.dat.hasApiKey, "boolean");
    assert.equal("apiKey" in (snap.dat as object), false);
    assert.equal(snap.dat.enabled, false);
    assert.equal(snap.truckstop.enabled, false);
});

test("Phase 5B: internal provider available with external not configured", async () => {
    const engine = new MarketRateEngine(createTestRegistry([internalHistoricalRateProvider, datMarketRateProvider, truckstopMarketRateProvider]));
    const result = await engine.quote(actor, request);
    assert.ok(result.providers.length >= 3);
    assert.equal(result.providerStatuses.DAT, "NOT_CONFIGURED");
    assert.equal(result.providerStatuses.TRUCKSTOP, "NOT_CONFIGURED");
    assert.notEqual(result.status, "FORBIDDEN");
});

test("Phase 5B: DAT timeout does not block Truckstop", async () => {
    const datTimeout = mockProvider("DAT", "DatMock", "TIMEOUT", {
        errorCode: "TIMEOUT",
        errorMessage: "timeout",
        rawAvailability: "ERROR",
    });
    const tsOk = mockProvider("TRUCKSTOP", "TruckstopMock", "AVAILABLE", {
        rate: 3280,
        rpm: 2.19,
        rawAvailability: "DATA",
        rateRange: { low: 3200, high: 3400, median: 3280, p25: 3200, p75: 3400 },
    });

    const internal = minimalInternalResult();
    const retrievedAt = new Date().toISOString();
    const composite = buildMarketRateCompositeResult({
        internal,
        providerQuotes: [
            mapInternalResultToNormalized(internal, retrievedAt),
            await datTimeout.getMarketRate(actor, request, { retrievedAt, timeoutMs: 100, retryCount: 0 }),
            await tsOk.getMarketRate(actor, request, { retrievedAt, timeoutMs: 100, retryCount: 0 }),
        ],
        retrievedAt,
    });

    assert.equal(composite.providerStatuses.DAT, "TIMEOUT");
    assert.equal(composite.providerStatuses.TRUCKSTOP, "AVAILABLE");
    assert.ok(composite.externalMarket);
    assert.equal(composite.answerMode, "market_comparison");
});

test("Phase 5B: DAT error + Truckstop available", async () => {
    const datErr = mockProvider("DAT", "DatMock", "ERROR", {
        errorCode: "PROVIDER_ERROR",
        errorMessage: "provider down",
        rawAvailability: "ERROR",
    });
    const tsOk = mockProvider("TRUCKSTOP", "TruckstopMock", "AVAILABLE", {
        rate: 3340,
        rawAvailability: "DATA",
    });
    const retrievedAt = new Date().toISOString();
    const internal = minimalInternalResult();
    const composite = buildMarketRateCompositeResult({
        internal,
        providerQuotes: [
            mapInternalResultToNormalized(internal, retrievedAt),
            await datErr.getMarketRate(actor, request, { retrievedAt, timeoutMs: 100, retryCount: 0 }),
            await tsOk.getMarketRate(actor, request, { retrievedAt, timeoutMs: 100, retryCount: 0 }),
        ],
        retrievedAt,
    });
    assert.equal(composite.providerStatuses.DAT, "ERROR");
    assert.equal(composite.providerStatuses.TRUCKSTOP, "AVAILABLE");
});

test("Phase 5B: both external providers available", async () => {
    const datOk = mockProvider("DAT", "DatMock", "AVAILABLE", {
        rate: 3280,
        rawAvailability: "DATA",
    });
    const tsOk = mockProvider("TRUCKSTOP", "TruckstopMock", "AVAILABLE", {
        rate: 3340,
        rawAvailability: "DATA",
    });
    const retrievedAt = new Date().toISOString();
    const internal = minimalInternalResult();
    const composite = buildMarketRateCompositeResult({
        internal,
        providerQuotes: [
            mapInternalResultToNormalized(internal, retrievedAt),
            await datOk.getMarketRate(actor, request, { retrievedAt, timeoutMs: 100, retryCount: 0 }),
            await tsOk.getMarketRate(actor, request, { retrievedAt, timeoutMs: 100, retryCount: 0 }),
        ],
        retrievedAt,
    });
    assert.deepEqual(composite.externalMarket?.providersWithData, ["DAT", "TRUCKSTOP"]);
    assert.equal(composite.answerMode, "market_comparison");
});

test("Phase 5B: all external unavailable — internal only", async () => {
    const retrievedAt = new Date().toISOString();
    const internal = minimalInternalResult();
    const composite = buildMarketRateCompositeResult({
        internal,
        providerQuotes: [
            mapInternalResultToNormalized(internal, retrievedAt),
            await datMarketRateProvider.getMarketRate(actor, request, { retrievedAt, timeoutMs: 100, retryCount: 0 }),
            await truckstopMarketRateProvider.getMarketRate(actor, request, { retrievedAt, timeoutMs: 100, retryCount: 0 }),
        ],
        retrievedAt,
    });
    assert.equal(composite.answerMode, "internal_market");
    assert.equal(composite.externalMarket, null);
});

test("Phase 5B: no fabricated external rates from stubs", async () => {
    const datQuote = await datMarketRateProvider.getMarketRate(actor, request, {
        retrievedAt: new Date().toISOString(),
        timeoutMs: 100,
        retryCount: 0,
    });
    assert.equal(datQuote.rate, null);
    assert.equal(datQuote.rawAvailability, "NOT_CONNECTED");
});

test("Phase 5B: source attribution per provider", async () => {
    const datOk = mockProvider("DAT", "DatMock", "AVAILABLE", {
        rate: 3280,
        sourceReference: "DAT-LANE-REF",
        rawAvailability: "DATA",
    });
    const quote = await datOk.getMarketRate(actor, request, {
        retrievedAt: new Date().toISOString(),
        timeoutMs: 100,
        retryCount: 0,
    });
    assert.equal(quote.source, "DAT");
    assert.equal(quote.sourceReference, "DAT-LANE-REF");
});

test("Phase 5B: timestamp retrievedAt on composite", () => {
    const retrievedAt = "2026-08-22T12:00:00.000Z";
    const internal = minimalInternalResult();
    const composite = buildMarketRateCompositeResult({
        internal,
        providerQuotes: [mapInternalResultToNormalized(internal, retrievedAt)],
        retrievedAt,
    });
    assert.equal(composite.retrievedAt, retrievedAt);
});

test("Phase 5B: carrier quote comparison across sources", () => {
    const retrievedAt = new Date().toISOString();
    const internal = minimalInternalResult({ carrierQuote: 3600 });
    const composite = buildMarketRateCompositeResult({
        internal,
        providerQuotes: [
            mapInternalResultToNormalized(internal, retrievedAt),
            {
                providerId: "DAT",
                providerName: "DatMock",
                source: "DAT",
                lifecycleStatus: "AVAILABLE",
                errorCode: null,
                errorMessage: null,
                origin: null,
                destination: null,
                equipment: null,
                miles: 1500,
                currency: "USD",
                rate: 3280,
                rpm: null,
                rateRange: { low: 3200, high: 3400, median: 3280, p25: 3200, p75: 3400 },
                sampleSize: null,
                confidence: "UNKNOWN",
                retrievedAt,
                providerTimestamp: retrievedAt,
                expirationAt: null,
                sourceReference: "DAT",
                rawAvailability: "DATA",
                providerMetadata: {},
            },
        ],
        retrievedAt,
    });
    assert.equal(composite.comparison?.carrierQuote, 3600);
    assert.equal(composite.comparison?.vsDat, "ABOVE");
});

test("Phase 5B: insufficient internal — no invented rate", () => {
    const retrievedAt = new Date().toISOString();
    const internal = minimalInternalResult({
        status: "INSUFFICIENT_DATA",
        sampleSize: 0,
        rpm: null,
        rate: null,
        recommendedTarget: null,
        confidence: null,
        message: "Insufficient GreenOS historical data",
    });
    const composite = buildMarketRateCompositeResult({
        internal,
        providerQuotes: [mapInternalResultToNormalized(internal, retrievedAt)],
        retrievedAt,
    });
    assert.equal(composite.recommendedTarget, null);
    assert.equal(composite.status, "INSUFFICIENT_DATA");
});

test("Phase 5B: provider normalization fields", async () => {
    const quote = await truckstopMarketRateProvider.getMarketRate(actor, request, {
        retrievedAt: new Date().toISOString(),
        timeoutMs: 100,
        retryCount: 0,
    });
    assert.equal(quote.currency, "USD");
    assert.equal(quote.confidence, "NOT_PROVIDED");
    assert.ok(quote.retrievedAt);
});
