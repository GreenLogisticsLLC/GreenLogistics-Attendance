import { buildMarketRateCompositeResult } from "./aggregation.js";
import { getMarketRateConfig } from "./market-rate-config.js";
import { internalHistoricalRateProvider } from "./internal-historical-provider.js";
import { mapInternalResultToNormalized } from "./internal-to-normalized.js";
import type { MarketRateProviderRegistry } from "./provider-registry.js";
import { marketRateProviderRegistry } from "./provider-registry.js";
import { runProviderQuote } from "./provider-runner.js";
import type { MarketRateCompositeResult } from "./provider-types.js";
import type { MarketRateRequest, RateActor } from "./types.js";

/**
 * Market Rate Engine — orchestrates Internal + DAT + Truckstop providers.
 * Phase 5B: external providers are stubs (NOT CONNECTED).
 * Providers execute independently; partial failures do not block others.
 */
export class MarketRateEngine {
    private registry: MarketRateProviderRegistry;

    constructor(registry: MarketRateProviderRegistry = marketRateProviderRegistry) {
        this.registry = registry;
    }

    async quote(actor: RateActor, request: MarketRateRequest): Promise<MarketRateCompositeResult> {
        const retrievedAt = new Date().toISOString();
        const config = getMarketRateConfig();
        const context = {
            retrievedAt,
            timeoutMs: config.providerTimeoutMs,
            retryCount: config.providerRetryCount,
        };

        const internalResult = await internalHistoricalRateProvider.quote(actor, request);

        const externalProviders = this.registry
            .list()
            .filter((provider) => provider.id !== "INTERNAL_HISTORICAL");
        const externalQuotes = await Promise.all(
            externalProviders.map((provider) => runProviderQuote(provider, actor, request, context))
        );

        const internalQuote = mapInternalResultToNormalized(internalResult, retrievedAt);

        const providerQuotes = [internalQuote, ...externalQuotes];

        return buildMarketRateCompositeResult({
            internal: internalResult,
            providerQuotes,
            retrievedAt,
        });
    }
}

export const marketRateEngine = new MarketRateEngine();
