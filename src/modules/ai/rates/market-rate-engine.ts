import { internalHistoricalRateProvider } from "./internal-historical-provider.js";
import type { MarketRateProvider, MarketRateRequest, MarketRateResult, RateActor } from "./types.js";

/**
 * Market Rate Engine — provider abstraction.
 * Phase 5A: InternalHistoricalRateProvider only.
 * Phase 5B: DATProvider, TruckstopProvider, etc.
 */
export class MarketRateEngine {
    private providers: MarketRateProvider[];

    constructor(providers: MarketRateProvider[] = [internalHistoricalRateProvider]) {
        this.providers = providers;
    }

    async quote(actor: RateActor, request: MarketRateRequest): Promise<MarketRateResult> {
        for (const provider of this.providers) {
            const result = await provider.quote(actor, request);
            if (result.status !== "INSUFFICIENT_DATA" || this.providers.length === 1) {
                return result;
            }
        }
        return internalHistoricalRateProvider.quote(actor, request);
    }
}

export const marketRateEngine = new MarketRateEngine();
