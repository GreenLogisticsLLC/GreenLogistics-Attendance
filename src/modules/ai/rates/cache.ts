import type { MarketRateProviderId, NormalizedProviderQuote } from "./provider-types.js";

export type CachedProviderResult = {
    providerId: MarketRateProviderId;
    cacheKey: string;
    quote: NormalizedProviderQuote;
    retrievedAt: string;
    /** TTL ms — provider-specific; null until official docs define limits. */
    ttlMs: number | null;
};

/**
 * In-memory provider result cache abstraction (Phase 5B architecture).
 * No Redis. No persistent DB table in this phase.
 *
 * Cache key dimensions: provider + lane + equipment + query parameters hash.
 * Actual TTL must be set per provider from official API documentation.
 */
export interface MarketRateCache {
    get(key: string): CachedProviderResult | null;
    set(entry: CachedProviderResult): void;
    delete(key: string): void;
}

export function buildCacheKey(input: {
    providerId: MarketRateProviderId;
    originZip?: string | null;
    destinationZip?: string | null;
    originCity?: string | null;
    originState?: string | null;
    destinationCity?: string | null;
    destinationState?: string | null;
    equipment?: string | null;
    miles?: number | null;
}): string {
    const parts = [
        input.providerId,
        input.originZip || "",
        input.destinationZip || "",
        input.originCity || "",
        input.originState || "",
        input.destinationCity || "",
        input.destinationState || "",
        input.equipment || "",
        input.miles != null ? String(input.miles) : "",
    ];
    return parts.join("|").toUpperCase();
}

export class InMemoryMarketRateCache implements MarketRateCache {
    private store = new Map<string, CachedProviderResult>();

    get(key: string): CachedProviderResult | null {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (entry.ttlMs != null) {
            const age = Date.now() - new Date(entry.retrievedAt).getTime();
            if (age > entry.ttlMs) {
                this.store.delete(key);
                return null;
            }
        }
        return entry;
    }

    set(entry: CachedProviderResult): void {
        this.store.set(entry.cacheKey, entry);
    }

    delete(key: string): void {
        this.store.delete(key);
    }
}

/** Singleton — not wired to engine until provider TTL docs are available. */
export const marketRateCache = new InMemoryMarketRateCache();
