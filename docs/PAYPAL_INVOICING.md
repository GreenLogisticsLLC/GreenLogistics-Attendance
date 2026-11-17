# PayPal Invoicing (Invoicing API v2)

GreenOS can create, send, remind, cancel and reconcile **PayPal-hosted customer invoices** through the
[PayPal Invoicing API v2](https://developer.paypal.com/docs/api/invoicing/v2/). This is a separate
integration from [PayPal Checkout](./PAYPAL_CHECKOUT.md) (Orders API v2 payment links).

| | Checkout | Invoicing |
| --- | --- | --- |
| API | `/v2/checkout/orders` | `/v2/invoicing/invoices` |
| Id | Order id | Invoice id (`INV2-…`) — never a Checkout order id |
| Customer pays on | PayPal approval page (link) | PayPal-hosted invoice page |
| Mode switch | `PAYPAL_MODE` | `PAYPAL_INVOICING_MODE` (independent, default `sandbox`) |
| Webhook id | `PAYPAL_*_WEBHOOK_ID` | `PAYPAL_*_INVOICING_WEBHOOK_ID` |
| Local table | `paypal_customer_orders` | `paypal_customer_invoices` + `paypal_invoice_operations` |

## Architecture

- `src/modules/accounting/paypal/paypal-env.ts` — per-environment credentials, `getActiveInvoicingEnv()`,
  `assertInvoicingEnvConfigured()`, `listWebhookCapablePayPalTargets()` (Checkout + Invoicing webhook ids,
  each with its own environment's credentials).
- `paypal-invoicing-client.ts` — thin v2 client (`createDraftInvoice`, `getInvoice`, `updateDraftInvoice`,
  `sendInvoice`, `cancelInvoice`, `deleteDraftInvoice`, `remindInvoice`, `searchInvoices`) plus
  `buildPayPalInvoicePayload`. Reuses the dual-env OAuth cache and fetch wrapper from `paypal-client.ts`.
  Tokens and secrets are never logged.
- `paypal-invoicing-safety.ts` — attempt keys, reusable-open-invoice rules, exact-cents paid-amount check,
  forward-only status transitions, ambiguous-failure classification.
- `paypal-invoicing.service.ts` — `payPalInvoicingService` (preview, createDraft, send, cancel, remind, sync,
  `handleInvoicingWebhookEvent`).
- `paypal-checkout.service.ts#handleWebhook` — verifies the signature, claims the event, and delegates
  `INVOICING.*` events to the invoicing service (the event row stores `paypal_invoice_id`). Checkout events
  are unchanged.

### Routes (permission: `BillingSend`)

```
POST /api/accounting/shipments/:id/paypal-invoice/preview
POST /api/accounting/shipments/:id/paypal-invoice/create    { "confirmPricing": true }
POST /api/accounting/shipments/:id/paypal-invoice/send
POST /api/accounting/shipments/:id/paypal-invoice/cancel    { "note": "optional" }
POST /api/accounting/shipments/:id/paypal-invoice/remind
POST /api/accounting/shipments/:id/paypal-invoice/sync
```

Amounts always come from the server (`customerPaymentQuote` / the locked pricing snapshot), never the body.
`GET /shipments/:id` returns `paypalInvoice` (latest local row) and
`paypalInvoicing: { mode, configured, webhookConfigured }` next to `paypalPayment`.

### Pricing and the handling fee

- Line items: one freight subtotal line plus an optional handling-fee line from Invoice Pricing settings
  (`docs/INVOICE_PRICING.md`). The fee is **off by default**, method-neutral, and is never labelled as a PayPal
  surcharge (labels containing "PayPal" or "surcharge" are replaced by "Handling fee").
- `createDraft` requires `confirmPricing: true` and locks the GreenOS pricing snapshot on the shipment the same
  way `createInvoice` does. Later changes to Invoice Pricing settings never change an existing invoice.
- PayPal's own processing fees are separate and never added.

### Idempotency and retries

- Every logical create has one attempt key (`invoicingAttemptKey`) and one `PayPal-Request-Id`
  (`paypal_invoice_operations.request_id`, unique). A timeout/5xx/network failure leaves the operation
  `PENDING`; the retry reuses the **same** request id and first searches PayPal by invoice number, so a
  timeout never mints a new key and never creates a duplicate.
- A definite rejection (4xx) closes that attempt (`FAILED`); the next create uses the next attempt key and a
  `-R<n>` invoice-number suffix (PayPal rejects duplicate invoice numbers).
- `idempotency_key`, `create_request_id` and `paypal_invoice_id` are unique, so concurrent creates converge on
  one row.
- Blocks: customer already paid, a completed Checkout payment, or an open invoice in the same environment that
  does not match the current amount. A matching open invoice is reused.

### Immediate send (not SCHEDULED)

PayPal `/send` **schedules** the invoice when `detail.invoice_date` is in the future in the **merchant PayPal
profile timezone**. GreenOS therefore:

1. Creates drafts with a past UTC issue date.
2. Before every `/send`, rewrites `invoice_date` to UTC yesterday (`ensureInvoiceIssueDateForImmediateSend`).
3. Calls `/send` with `send_to_recipient: true`.
4. Treats a remaining `SCHEDULED`/`DRAFT` status after send as failure (`PAYPAL_INVOICE_STILL_SCHEDULED`).
5. Allows **Send via PayPal** again for local `SCHEDULED` rows so Accounting can force-email stuck invoices.

### Payment confirmation

Customers pay on the PayPal-hosted invoice, so GreenOS **never calls the record-payment API**. A shipment becomes
`CUSTOMER_PAID` only when the invoice is `PAID` and the paid amount equals the GreenOS total to the cent
(webhook payload, or a GET when the payload has no amounts). Anything ambiguous sets `needs_accounting_review`
and does not mark the shipment paid: amount mismatch, `MARKED_AS_PAID`, `PARTIALLY_PAID`, partial refunds,
total drift in PayPal, or a shipment that was already paid/reversed. `REFUNDED` moves a paid shipment to
`CUSTOMER_REFUNDED`. Stale events never reopen a cancelled/refunded invoice. A DRAFT invoice is cancelled by
deleting it (PayPal only cancels sent invoices).

## Environment variables

```
PAYPAL_INVOICING_MODE=sandbox            # sandbox (default) | live — independent of PAYPAL_MODE
PAYPAL_SANDBOX_CLIENT_ID= / _SECRET=      # shared with Checkout
PAYPAL_LIVE_CLIENT_ID= / _SECRET=         # shared with Checkout
PAYPAL_SANDBOX_INVOICING_WEBHOOK_ID=
PAYPAL_LIVE_INVOICING_WEBHOOK_ID=
```

Invoicing uses the same client credentials as the selected environment. LIVE never falls back to Sandbox
credentials. Do not commit secrets; set them only in the server environment.

## Webhook registration

Register one webhook per PayPal environment (Sandbox app, LIVE app):

- URL: `https://os.greengrouplogistics.com/api/webhooks/paypal`
- Events: `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.CANCELLED`, `INVOICING.INVOICE.REFUNDED`,
  `INVOICING.INVOICE.SCHEDULED`, `INVOICING.INVOICE.CREATED`, `INVOICING.INVOICE.UPDATED`
- Copy the webhook id into `PAYPAL_SANDBOX_INVOICING_WEBHOOK_ID` / `PAYPAL_LIVE_INVOICING_WEBHOOK_ID`.

The endpoint is shared with Checkout. Signature verification tries every configured Checkout and Invoicing
webhook id against the credentials of its own environment, so a Checkout webhook and an Invoicing webhook can
point at the same URL.

## LIVE activation checklist

1. Sandbox verified end-to-end: draft → send → pay in the Sandbox buyer account → webhook marks the shipment
   `CUSTOMER_PAID`; cancel and remind also work.
2. `PAYPAL_LIVE_CLIENT_ID` / `PAYPAL_LIVE_CLIENT_SECRET` are set and the LIVE app has Invoicing permissions.
3. Register the LIVE Invoicing webhook (URL and events above) and set `PAYPAL_LIVE_INVOICING_WEBHOOK_ID`.
4. Review Accounting → Invoice Pricing: the fee stays off unless Owner/Administrator enabled it with the policy
   acknowledgment. Never enable a PayPal-only surcharge.
5. Only then set `PAYPAL_INVOICING_MODE=live` and restart Node. Do **not** change `PAYPAL_MODE` for this.
6. Create one low-value live invoice first, confirm the hosted page, payment, and webhook delivery.
7. Roll back by setting `PAYPAL_INVOICING_MODE=sandbox`; existing live invoices keep their `environment` and are
   still synced/cancelled against LIVE.

## Database

Additive only: `paypal_customer_invoices`, `paypal_invoice_operations`, and `paypal_webhook_events.paypal_invoice_id`
(applied with `prisma db push` like the other PayPal tables).
