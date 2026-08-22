import type { MarketRateRequest, RateActor } from "./types.js";
import type {
    MarketRateProviderId,
    NormalizedProviderQuote,
    ProviderLifecycleStatus,
    ProviderRunContext,
} from "./provider-types.js";

/**
 * Normalized provider contract for Internal / DAT / Truckstop.
 * Orchestrator and API call MarketRateEngine only — never providers directly.
 */
export interface MarketRateProvider {
    readonly id: MarketRateProviderId;
    readonly name: string;
    getLifecycleStatus(): ProviderLifecycleStatus;
    getMarketRate(
        actor: RateActor,
        request: MarketRateRequest,
        context: ProviderRunContext
    ): Promise<NormalizedProviderQuote>;
}
