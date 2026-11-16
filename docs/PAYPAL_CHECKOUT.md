# PayPal Checkout — Customer Payment Links (Phase 1)

Accounting can open a shipment, generate a **real PayPal Checkout** payment link for the customer’s outstanding amount, copy it, email it, and track capture status. Paid is set only after a successful PayPal **capture** (Orders API or verified webhook).

**Do not enable `PAYPAL_MODE=live` or merge to production without management approval.** Contabo auto-deploys from `main`; keep this on a feature PR until approved.

## Environment

Dual-environment credentials (preferred):

```bash
PAYPAL_MODE=sandbox          # active Checkout selector (default sandbox)
PAYPAL_SANDBOX_CLIENT_ID=...
PAYPAL_SANDBOX_CLIENT_SECRET=...
PAYPAL_SANDBOX_WEBHOOK_ID=...
PAYPAL_LIVE_CLIENT_ID=...      # optional until LIVE go-live
PAYPAL_LIVE_CLIENT_SECRET=...
PAYPAL_LIVE_WEBHOOK_ID=...
PUBLIC_APP_URL=https://your-public-host   # used for return/cancel URLs
```

Legacy aliases still work and map to **Sandbox only** (never LIVE):

```bash
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_WEBHOOK_ID=...
```

Corporate SMTP (existing Accounting mail) must already work for **Send to Customer**.

Credentials stay **server-side only** (`src/config/env.ts` → `config.paypal`). Never put secrets in the frontend. Missing LIVE credentials must not break Sandbox; missing Sandbox must not silently use LIVE for Checkout.

| Environment | API base |
|-------------|----------|
| sandbox (default Checkout) | `https://api-m.sandbox.paypal.com` |
| live | `https://api-m.paypal.com` |

`POST /api/webhooks/paypal` verifies signatures against **each configured webhook environment** (Sandbox and/or LIVE) using that environment’s own credentials + webhook id. `PAYPAL_MODE` does **not** decide which webhook is valid.

## Database

New tables (no duplicate Customer/Invoice models):

- `paypal_customer_orders` (`PayPalCustomerOrder`) — order id, amount snapshot, approval URL, status, capture, email audit, idempotency key → `ShipmentLead`
- `paypal_webhook_events` (`PayPalWebhookEvent`) — event id uniqueness for safe duplicates

Amount is always taken from `customerPaymentQuote` on the shipment (customer rate + accessorials + optional 3% fee), never from the request body.

Capture retries persist one stable `captureRequestId` (`PayPal-Request-Id`) plus
`captureStartedAt` / `captureCompletedAt`. An atomic database claim allows only
one concurrent request to call PayPal Capture; other requests perform read-only
reconciliation.

```bash
npx prisma db push
# or your usual migrate path
```

## API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/accounting/shipments/:id/paypal/generate` | JWT + BillingSend | Create/reuse PayPal order + approval URL |
| POST | `/api/accounting/shipments/:id/paypal/status` | JWT + BillingSend | Refresh order; capture if APPROVED |
| POST | `/api/accounting/shipments/:id/paypal/send` | JWT + BillingSend | Email approval URL via `sendCorporateMail` |
| POST | `/api/webhooks/paypal` | PayPal signature | Capture / status updates |

`GET /api/accounting/shipments/:id` includes `paypalPayment` + `paypal.configured` / `paypal.mode`.

Webhook URL to register in PayPal Sandbox:

`https://<PUBLIC_APP_URL>/api/webhooks/paypal`

Suggested event types: `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.ORDER.COMPLETED`, `CHECKOUT.ORDER.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`.

Webhook handling **never calls the Capture API**. `PAYMENT.CAPTURE.COMPLETED` is
signature-verified, matched to the persisted order/capture, checked against a
read-only PayPal Order response, and validated for exact amount + USD currency.
Event IDs are processed idempotently. Verified environment is stored on
`PayPalWebhookEvent.environment`.

`PAYMENT.CAPTURE.REVERSED` clears `CUSTOMER_PAID`, sets order status `REVERSED`,
flags `needsAccountingReview`, and sets shipment `paymentStatus=CUSTOMER_REVERSED`
(no automatic re-charge).

## Payment states

```text
CREATED ──customer approves──> APPROVED
APPROVED ──atomic capture claim──> CAPTURE_PENDING
CAPTURE_PENDING ──verified capture status=COMPLETED,
                   matching amount + USD──> COMPLETED ──refund──> REFUNDED
CAPTURE_PENDING ──PayPal denied──> DENIED
CAPTURE_PENDING ──validation/permanent error──> FAILED
COMPLETED ──refund──> REFUNDED
COMPLETED ──capture reversed──> REVERSED (Accounting review)
CREATED / APPROVED ──void/cancel──> CANCELLED
```

Only `COMPLETED` sets the shipment to `CUSTOMER_PAID`. A capture ID by itself is
never payment proof. Refund processing changes the order to `REFUNDED`, clears
the received-payment timestamp, and sets shipment status to
`CUSTOMER_REFUNDED`. Reversal never marks paid; it flags Accounting review.

The existing manual payment endpoint remains permission-gated by
`CustomerPaymentsRecord`. It rejects PayPal-method loads and active PayPal
orders; it is not a PayPal fallback.

## UI

Shipment Details (Accounting) → **Customer Payment (PayPal)** under Customer/Carrier Invoice:

- Generate PayPal Link  
- Copy Payment Link  
- Send to Customer  
- View Payment Status  

Shows invoice number, customer, amount, order id, URL, created by/at, status.

## Sandbox testing checklist

1. Set sandbox env vars; restart the server; `prisma db push`.
2. Open an unpaid Accounting shipment with customer rate (and preferred payment method) saved.
3. **Generate PayPal Link** → approval URL + Order ID appear.
4. Click Generate again with the same amount → same open order (idempotency).
5. **Copy Payment Link** / open URL in a browser → Sandbox buyer pays.
6. **View Payment Status** (or wait for webhook) → status COMPLETED; shipment customer paid.
7. **Send to Customer** → email with PayPal button (SMTP).
8. Replay the same webhook body → `duplicate: true`, no double-pay.
9. Cancel checkout in PayPal → order not marked paid; regenerate if needed after void/fail.
10. Unset credentials → generate returns PayPal-not-configured (503).

## Remaining LIVE activation steps (ops — not this PR)

Do **not** flip LIVE in this PR. When management approves:

1. Create a Live PayPal REST app; copy `PAYPAL_LIVE_CLIENT_ID` / `PAYPAL_LIVE_CLIENT_SECRET`.
2. Register webhook URL `https://<PUBLIC_APP_URL>/api/webhooks/paypal` on the **Live** app; copy `PAYPAL_LIVE_WEBHOOK_ID` (include `PAYMENT.CAPTURE.REVERSED`).
3. Keep Sandbox vars intact; set Live vars alongside them.
4. Run `npx prisma db push` (additive columns: `environment`, `reversal_id`, `reversed_at`, `needs_accounting_review`).
5. Restart the Node process so env vars load.
6. Verify dual webhook: Sandbox + Live deliveries both return 200; invalid signatures 401.
7. Only then set `PAYPAL_MODE=live` for Checkout (webhooks already verify both).
8. Smoke-test one small real payment + refund path under Accounting supervision.

## Out of scope (Phase 1)

Stripe, Cash App, ACH, Wire, Zelle UI, carrier payouts, Customer Portal, unrelated Accounting redesign.
