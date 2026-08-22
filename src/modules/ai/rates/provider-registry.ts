import { getMarketRateConfig } from "./market-rate-config.js";
import { datMarketRateProvider } from "./dat-market-rate-provider.js";
import { internalHistoricalRateProvider } from "./internal-historical-provider.js";
import type { MarketRateProvider } from "./provider-interface.js";
import type { MarketRateProviderId } from "./provider-types.js";
import { truckstopMarketRateProvider } from "./truckstop-market-rate-provider.js";

/**
 * Provider registry — factory for market rate providers.
 * Phase 5B: DAT and Truckstop are architectural stubs (NOT CONNECTED).
 */
export class MarketRateProviderRegistry {
    private providers: Map<MarketRateProviderId, MarketRateProvider>;

    constructor(providers: MarketRateProvider[] = defaultProviders()) {
        this.providers = new Map(providers.map((p) => [p.id, p]));
    }

    get(id: MarketRateProviderId): MarketRateProvider | undefined {
        return this.providers.get(id);
    }

    list(): MarketRateProvider[] {
        return [...this.providers.values()];
    }

    /** Providers eligible for this request — respects env enable flags. */
    getActiveProviders(): MarketRateProvider[] {
        const config = getMarketRateConfig();
        if (!config.marketRatesEnabled) {
            return [this.providers.get("INTERNAL_HISTORICAL")!].filter(Boolean);
        }

        const out: MarketRateProvider[] = [];
        const internal = this.providers.get("INTERNAL_HISTORICAL");
        if (internal) out.push(internal);

        if (config.dat.enabled) {
            const dat = this.providers.get("DAT");
            if (dat) out.push(dat);
        }

        if (config.truckstop.enabled) {
            const ts = this.providers.get("TRUCKSTOP");
            if (ts) out.push(ts);
        }

        return out;
    }

    getExternalProviders(): MarketRateProvider[] {
        return this.getActiveProviders().filter((p) => p.id !== "INTERNAL_HISTORICAL");
    }
}

function defaultProviders(): MarketRateProvider[] {
    return [internalHistoricalRateProvider, datMarketRateProvider, truckstopMarketRateProvider];
}

export const marketRateProviderRegistry = new MarketRateProviderRegistry();

export function createTestRegistry(providers: MarketRateProvider[]): MarketRateProviderRegistry {
    return new MarketRateProviderRegistry(providers);
}
