import { marketRateEngine } from "./market-rate-engine.js";
import type { MarketRateRequest, MarketRateResult, RateActor } from "./types.js";

export class MarketRateService {
    async quote(actor: RateActor, request: MarketRateRequest): Promise<MarketRateResult> {
        return marketRateEngine.quote(actor, request);
    }
}

export const marketRateService = new MarketRateService();
