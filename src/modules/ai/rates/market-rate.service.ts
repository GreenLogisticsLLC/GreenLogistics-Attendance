import { marketRateEngine } from "./market-rate-engine.js";
import type { MarketRateCompositeResult } from "./provider-types.js";
import type { MarketRateRequest, RateActor } from "./types.js";

export class MarketRateService {
    async quote(actor: RateActor, request: MarketRateRequest): Promise<MarketRateCompositeResult> {
        return marketRateEngine.quote(actor, request);
    }
}

export const marketRateService = new MarketRateService();
