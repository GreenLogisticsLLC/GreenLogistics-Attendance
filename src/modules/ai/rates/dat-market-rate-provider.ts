import { getMarketRateConfig } from "./market-rate-config.js";
import type { MarketRateProvider } from "./provider-interface.js";
import type { MarketRateRequest, RateActor } from "./types.js";
import type {
    NormalizedProviderQuote,
    ProviderLifecycleStatus,
    ProviderRunContext,
} from "./provider-types.js";
import { stubUnavailableQuote } from "./provider-runner.js";

/**
 * DAT market rate provider — ARCHITECTURE STUB ONLY.
 *
 * NOT CONNECTED. No HTTP requests. No invented endpoints or auth.
 * VERIFY AGAINST OFFICIAL DAT API DOCUMENTATION before activation.
 *
 * Required before activation (see docs/PHASE-5B-MARKET-RATE-PROVIDERS.md):
 * - Official API documentation
 * - Authentication mechanism (PENDING OFFICIAL API DOCUMENTATION)
 * - Credentials / API access approval
 * - Base URL (PENDING OFFICIAL API DOCUMENTATION)
 * - Market-rate endpoint (PENDING OFFICIAL API DOCUMENTATION)
 * - Request schema (PENDING OFFICIAL API DOCUMENTATION)
 * - Response schema (PENDING OFFICIAL API DOCUMENTATION)
 * - Rate limits (PENDING OFFICIAL API DOCUMENTATION)
 * - Commercial / usage restrictions
 * - Supported market-rate fields
 */
export class DatMarketRateProvider implements MarketRateProvider {
    readonly id = "DAT" as const;
    readonly name = "DatMarketRateProvider";

    getLifecycleStatus(): ProviderLifecycleStatus {
        const config = getMarketRateConfig();
        if (!config.dat.enabled) return "NOT_CONFIGURED";
        if (!config.dat.configured) return "NOT_CONFIGURED";
        return "CONFIGURED";
    }

    async getMarketRate(
        _actor: RateActor,
        _request: MarketRateRequest,
        context: ProviderRunContext
    ): Promise<NormalizedProviderQuote> {
        const status = this.getLifecycleStatus();
        if (status === "NOT_CONFIGURED") {
            return stubUnavailableQuote(
                "DAT",
                this.name,
                "DAT",
                "NOT_CONFIGURED",
                "NOT_CONFIGURED",
                "DAT market rates are not connected — awaiting official API documentation and credentials",
                context.retrievedAt
            );
        }

        // Future: official DAT API integration here — no implementation in Phase 5B.
        return stubUnavailableQuote(
            "DAT",
            this.name,
            "DAT",
            "UNAVAILABLE",
            "UNAVAILABLE",
            "DAT provider is configured but integration is not yet implemented — VERIFY AGAINST OFFICIAL DAT API DOCUMENTATION",
            context.retrievedAt
        );
    }
}

export const datMarketRateProvider = new DatMarketRateProvider();
