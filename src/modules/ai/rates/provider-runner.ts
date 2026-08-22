import type { MarketRateRequest, RateActor } from "./types.js";
import type { MarketRateProvider } from "./provider-interface.js";
import type {
    MarketRateProviderId,
    NormalizedProviderQuote,
    ProviderErrorCode,
    ProviderLifecycleStatus,
    ProviderRunContext,
} from "./provider-types.js";
import { getMarketRateConfig } from "./market-rate-config.js";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function stubUnavailableQuote(
    providerId: MarketRateProviderId,
    providerName: string,
    source: "DAT" | "TRUCKSTOP",
    lifecycleStatus: ProviderLifecycleStatus,
    errorCode: ProviderErrorCode,
    errorMessage: string,
    retrievedAt: string
): NormalizedProviderQuote {
    return {
        providerId,
        providerName,
        source,
        lifecycleStatus,
        errorCode,
        errorMessage,
        origin: null,
        destination: null,
        equipment: null,
        miles: null,
        currency: "USD",
        rate: null,
        rpm: null,
        rateRange: null,
        sampleSize: null,
        confidence: "NOT_PROVIDED",
        retrievedAt,
        providerTimestamp: null,
        expirationAt: null,
        sourceReference: null,
        rawAvailability: "NOT_CONNECTED",
        providerMetadata: {},
    };
}

export function createTimeoutQuote(
    providerId: MarketRateProviderId,
    providerName: string,
    source: "DAT" | "TRUCKSTOP" | "GREENOS_INTERNAL",
    retrievedAt: string
): NormalizedProviderQuote {
    return {
        providerId,
        providerName,
        source,
        lifecycleStatus: "TIMEOUT",
        errorCode: "TIMEOUT",
        errorMessage: `${providerName} request timed out`,
        origin: null,
        destination: null,
        equipment: null,
        miles: null,
        currency: "USD",
        rate: null,
        rpm: null,
        rateRange: null,
        sampleSize: null,
        confidence: "NOT_PROVIDED",
        retrievedAt,
        providerTimestamp: null,
        expirationAt: null,
        sourceReference: null,
        rawAvailability: "ERROR",
        providerMetadata: {},
    };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" })), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Run a provider independently with generic timeout/retry controls.
 * Provider-specific rate limits: PENDING OFFICIAL API DOCUMENTATION.
 */
export async function runProviderQuote(
    provider: MarketRateProvider,
    actor: RateActor,
    request: MarketRateRequest,
    context: ProviderRunContext
): Promise<NormalizedProviderQuote> {
    const config = getMarketRateConfig();
    const timeoutMs = context.timeoutMs || config.providerTimeoutMs;
    const retries = context.retryCount ?? config.providerRetryCount;
    const retrievedAt = context.retrievedAt;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
            await sleep(Math.min(250 * attempt, 1000));
        }
        try {
            return await withTimeout(
                provider.getMarketRate(actor, request, { ...context, retrievedAt }),
                timeoutMs
            );
        } catch (err) {
            lastError = err;
            const code =
                err && typeof err === "object" && "code" in err
                    ? String((err as { code: string }).code)
                    : "";
            if (code === "TIMEOUT") {
                return createTimeoutQuote(
                    provider.id,
                    provider.name,
                    provider.id === "INTERNAL_HISTORICAL" ? "GREENOS_INTERNAL" : provider.id,
                    retrievedAt
                );
            }
        }
    }

    const message = lastError instanceof Error ? lastError.message : "Provider error";
    if (provider.id === "DAT" || provider.id === "TRUCKSTOP") {
        return stubUnavailableQuote(
            provider.id,
            provider.name,
            provider.id,
            "ERROR",
            "PROVIDER_ERROR",
            message.slice(0, 200),
            retrievedAt
        );
    }

    return createTimeoutQuote(provider.id, provider.name, "GREENOS_INTERNAL", retrievedAt);
}

export { stubUnavailableQuote };
