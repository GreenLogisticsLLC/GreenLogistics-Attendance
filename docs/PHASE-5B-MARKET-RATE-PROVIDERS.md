# Phase 5B — External Market Rate Provider Architecture

**Status:** ARCHITECTURE COMPLETE — DAT and Truckstop are **NOT CONNECTED**.

GreenOS combines three market-rate sources through one abstraction:

```
MarketRateEngine
        ↓
MarketRateProviderRegistry
   ┌────┼───────────────┐
   ↓    ↓               ↓
Internal DAT         Truckstop
Historical Provider  Provider (stub) Provider (stub)
Provider             NOT CONNECTED NOT CONNECTED
(Phase 5A — live)
```

The AI Orchestrator calls **MarketRateEngine only** — never DAT or Truckstop directly.

---

## 1. Provider interface

File: `src/modules/ai/rates/provider-interface.ts`

```typescript
interface MarketRateProvider {
  readonly id: "INTERNAL_HISTORICAL" | "DAT" | "TRUCKSTOP";
  readonly name: string;
  getLifecycleStatus(): ProviderLifecycleStatus;
  getMarketRate(actor, request, context): Promise<NormalizedProviderQuote>;
}
```

Provider-specific fields stay in `providerMetadata` on the normalized quote.

---

## 2. Normalized request

File: `src/modules/ai/rates/types.ts` — `MarketRateRequest`

| Field | Notes |
|-------|--------|
| `shipmentId?` | ACL enforced via existing shipment access |
| `origin` / `destination` | Explicit lane |
| `originZip?` / `destinationZip?` | ZIP5 preferred |
| `originCity?` / `originState?` / … | City/state lane |
| `equipment?` | Normalized in internal provider |
| `miles?` | Required for shipment RPM |
| `weight?` / `pickupDate?` / `deliveryDate?` | Optional context |
| `currentCarrierQuote?` | Benchmark comparison |

---

## 3. Normalized provider quote

File: `src/modules/ai/rates/provider-types.ts` — `NormalizedProviderQuote`

Common fields only:

- `providerId`, `providerName`, `source`
- `lifecycleStatus`, `errorCode`, `errorMessage`
- `origin`, `destination`, `equipment`, `miles`
- `currency` (USD)
- `rate`, `rpm`, `rateRange` (low/high/median/p25/p75 — null when not provided)
- `sampleSize`, `confidence` (`HIGH|MEDIUM|LOW|UNKNOWN|NOT_PROVIDED`)
- `retrievedAt`, `providerTimestamp`, `expirationAt`
- `sourceReference`, `rawAvailability`
- `providerMetadata` (isolated provider-specific payload)

---

## 4. Composite API response

`POST /api/ai/rates/quote` returns `MarketRateCompositeResult`:

- **Phase 5A top-level fields preserved** (backward compatible)
- `retrievedAt`
- `answerMode`: `internal_market` | `external_market` | `market_comparison`
- `providers[]`
- `providerStatuses` (INTERNAL_HISTORICAL, DAT, TRUCKSTOP)
- `internalHistorical`, `internalHistoricalDetail`
- `externalMarket`, `combinedView`, `comparison`

Internal and external values are **never blended into one unexplained number**.

---

## 5. Provider lifecycle statuses

| Status | Meaning |
|--------|---------|
| `NOT_CONFIGURED` | Env/credentials not set — **Not connected** |
| `CONFIGURED` | Credentials present, integration not live |
| `AVAILABLE` | Provider returned usable data |
| `UNAVAILABLE` | Configured but no data / not ready |
| `ERROR` | Provider failure |
| `TIMEOUT` | Provider exceeded generic timeout |

---

## 6. Error model

Normalized `ProviderErrorCode`:

`NOT_CONFIGURED`, `AUTHENTICATION_ERROR`, `AUTHORIZATION_ERROR`, `RATE_LIMITED`, `TIMEOUT`, `BAD_REQUEST`, `PROVIDER_ERROR`, `INVALID_RESPONSE`, `UNAVAILABLE`

Raw provider errors must not expose credentials or sensitive payloads.

---

## 7. Provider registry

File: `src/modules/ai/rates/provider-registry.ts`

- `InternalHistoricalRateProvider` — live (Phase 5A)
- `DatMarketRateProvider` — stub
- `TruckstopMarketRateProvider` — stub

Engine always invokes external stubs so UI shows **Not connected** (not $0).

---

## 8. DAT adapter (NOT CONNECTED)

File: `src/modules/ai/rates/dat-market-rate-provider.ts`

- No HTTP requests
- No invented endpoints or authentication
- Returns `NOT_CONFIGURED` with `rate: null`

### Required before activation — VERIFY AGAINST OFFICIAL DAT API DOCUMENTATION

- [ ] Official API documentation
- [ ] API access approved
- [ ] Credentials
- [ ] Authentication instructions (**PENDING OFFICIAL API DOCUMENTATION**)
- [ ] Base URL (**PENDING OFFICIAL API DOCUMENTATION**)
- [ ] Market-rate endpoint (**PENDING OFFICIAL API DOCUMENTATION**)
- [ ] Request schema (**PENDING OFFICIAL API DOCUMENTATION**)
- [ ] Response schema (**PENDING OFFICIAL API DOCUMENTATION**)
- [ ] Rate limits (**PENDING OFFICIAL API DOCUMENTATION**)
- [ ] Pricing/contract terms
- [ ] Allowed use / attribution requirements
- [ ] Data retention restrictions

---

## 9. Truckstop adapter (NOT CONNECTED)

File: `src/modules/ai/rates/truckstop-market-rate-provider.ts`

Same rules as DAT. All unknown API details:

**VERIFY AGAINST OFFICIAL TRUCKSTOP API DOCUMENTATION**

Checklist identical to DAT section above.

---

## 10. Configuration (server-side only)

See `.env.example`:

```
MARKET_RATES_ENABLED=true
MARKET_RATE_PROVIDER_TIMEOUT_MS=8000
MARKET_RATE_PROVIDER_RETRY_COUNT=0

DAT_MARKET_RATES_ENABLED=false
DAT_API_BASE_URL=
DAT_API_KEY=              # PENDING OFFICIAL API DOCUMENTATION
DAT_CLIENT_ID=            # PENDING OFFICIAL API DOCUMENTATION
DAT_CLIENT_SECRET=        # PENDING OFFICIAL API DOCUMENTATION

TRUCKSTOP_MARKET_RATES_ENABLED=false
TRUCKSTOP_API_BASE_URL=
TRUCKSTOP_API_KEY=        # PENDING OFFICIAL API DOCUMENTATION
TRUCKSTOP_CLIENT_ID=      # PENDING OFFICIAL API DOCUMENTATION
TRUCKSTOP_CLIENT_SECRET=  # PENDING OFFICIAL API DOCUMENTATION
```

`getMarketRateConfigForStatus()` returns **presence flags only** — never secret values.

Secrets must never appear in: frontend, localStorage, Git, AI prompts, `ai_runs`, or normal logs.

---

## 11. Partial failure

Providers run **independently** via `Promise.all` on external stubs/adapters.

Example:

| Provider | Status | Engine behavior |
|----------|--------|-----------------|
| Internal | AVAILABLE | Included |
| DAT | TIMEOUT | Disclosed; others continue |
| Truckstop | AVAILABLE | Included in `externalMarket` |

Failed providers are listed in `providerStatuses` — never hidden.

---

## 12. Timeout / retry

File: `src/modules/ai/rates/provider-runner.ts`

- Generic defaults: 8000ms timeout, 0 retries (env-configurable)
- Provider-specific limits: **PENDING OFFICIAL API DOCUMENTATION**
- DAT timeout does not block Truckstop

---

## 13. Caching (architecture only)

File: `src/modules/ai/rates/cache.ts`

- In-memory abstraction (`InMemoryMarketRateCache`)
- No Redis, no persistent DB table in Phase 5B
- Cache key: provider + lane + equipment + miles
- TTL: **provider-specific — PENDING OFFICIAL API DOCUMENTATION**
- Not wired to live engine until official TTL guidance exists

---

## 14. Aggregation

File: `src/modules/ai/rates/aggregation.ts`

- `externalMarket` — range across available external providers only
- `combinedView` — side-by-side internal target + external range (not merged)
- `comparison` — carrier quote vs internal / DAT / Truckstop (deterministic backend math)
- External confidence defaults to `UNKNOWN` until provider docs define scoring

---

## 15. AI integration

Rate intents unchanged (`rate_analysis`, `historical_rate`, `lane_rate`, `carrier_quote_comparison`).

Answer modes:

| Mode | When |
|------|------|
| `internal_market` | GreenOS historical only |
| `external_market` | External provider data only |
| `market_comparison` | Internal + external available |

LLM receives formatted text from backend — **must not alter provider numbers**.

---

## 16. UI

Load detail **Internal Market Rate** panel shows:

- GreenOS historical stats (Phase 5A)
- DAT / Truckstop: **Not connected** when `NOT_CONFIGURED`
- `retrievedAt`

No $0 placeholders for unconnected providers.

---

## 17. Security

- Broker-scoped internal historical data unchanged (ACL before statistics)
- Shipment ACL on `shipmentId` requests
- Credentials server-side only
- No `/api/dat` or `/api/truckstop` routes — engine is the boundary

---

## 18. Testing

File: `src/modules/ai/ai-phase5b-market-rate.test.ts`

Mock providers only — **no external API calls**.

---

## 19. Next step

**WAIT FOR OFFICIAL DAT + TRUCKSTOP API DOCUMENTATION AND CREDENTIALS**

Do **not** activate providers until checklists above are complete.

**NO scraping. NO invented endpoints. NO production external calls in Phase 5B.**
