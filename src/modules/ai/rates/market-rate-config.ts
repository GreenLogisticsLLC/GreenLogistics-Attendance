/**
 * Market rate configuration — server-side env only. No secrets exposed to clients.
 * Uncertain credential names marked PENDING OFFICIAL API DOCUMENTATION.
 */

export type MarketRateConfigSnapshot = {
    marketRatesEnabled: boolean;
    dat: {
        enabled: boolean;
        configured: boolean;
        /** Never includes secret values — presence flags only. */
        hasApiBaseUrl: boolean;
        hasApiKey: boolean;
        hasClientId: boolean;
        hasClientSecret: boolean;
    };
    truckstop: {
        enabled: boolean;
        configured: boolean;
        hasApiBaseUrl: boolean;
        hasApiKey: boolean;
        hasClientId: boolean;
        hasClientSecret: boolean;
    };
    providerTimeoutMs: number;
    providerRetryCount: number;
};

function envFlag(key: string, defaultValue = false): boolean {
    const v = (process.env[key] || "").trim().toLowerCase();
    if (!v) return defaultValue;
    return v === "1" || v === "true" || v === "yes";
}

function envPresent(key: string): boolean {
    return Boolean((process.env[key] || "").trim());
}

function envInt(key: string, defaultValue: number): number {
    const n = Number(process.env[key]);
    return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

/** Generic defaults for provider runner — external limits TBD from official docs. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 8000;
export const DEFAULT_PROVIDER_RETRY_COUNT = 0;

export function getMarketRateConfig(): MarketRateConfigSnapshot {
    const datEnabled = envFlag("DAT_MARKET_RATES_ENABLED", false);
    const truckstopEnabled = envFlag("TRUCKSTOP_MARKET_RATES_ENABLED", false);

    const datHasCreds =
        envPresent("DAT_API_BASE_URL") &&
        (envPresent("DAT_API_KEY") ||
            (envPresent("DAT_CLIENT_ID") && envPresent("DAT_CLIENT_SECRET")));

    const truckstopHasCreds =
        envPresent("TRUCKSTOP_API_BASE_URL") &&
        (envPresent("TRUCKSTOP_API_KEY") ||
            (envPresent("TRUCKSTOP_CLIENT_ID") && envPresent("TRUCKSTOP_CLIENT_SECRET")));

    return {
        marketRatesEnabled: envFlag("MARKET_RATES_ENABLED", true),
        dat: {
            enabled: datEnabled,
            configured: datEnabled && datHasCreds,
            hasApiBaseUrl: envPresent("DAT_API_BASE_URL"),
            hasApiKey: envPresent("DAT_API_KEY"),
            hasClientId: envPresent("DAT_CLIENT_ID"),
            hasClientSecret: envPresent("DAT_CLIENT_SECRET"),
        },
        truckstop: {
            enabled: truckstopEnabled,
            configured: truckstopEnabled && truckstopHasCreds,
            hasApiBaseUrl: envPresent("TRUCKSTOP_API_BASE_URL"),
            hasApiKey: envPresent("TRUCKSTOP_API_KEY"),
            hasClientId: envPresent("TRUCKSTOP_CLIENT_ID"),
            hasClientSecret: envPresent("TRUCKSTOP_CLIENT_SECRET"),
        },
        providerTimeoutMs: envInt("MARKET_RATE_PROVIDER_TIMEOUT_MS", DEFAULT_PROVIDER_TIMEOUT_MS),
        providerRetryCount: envInt("MARKET_RATE_PROVIDER_RETRY_COUNT", DEFAULT_PROVIDER_RETRY_COUNT),
    };
}

/** Safe for API status — never returns credential values. */
export function getMarketRateConfigForStatus(): MarketRateConfigSnapshot {
    return getMarketRateConfig();
}
