# PayPal Checkout — Customer Payment Links (Phase 1)

Accounting can open a shipment, generate a **real PayPal Checkout** payment link for the customer’s outstanding amount, copy it, email it, and track capture status. Paid is set only after a successful PayPal **capture** (Orders API or verified webhook).

**Do not enable `PAYPAL_MODE=live` or merge to production without management approval.** Contabo auto-deploys from `main`; keep this on a feature PR until approved.

## Environment

```bash
PAYPAL_MODE=sandbox
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_WEBHOOK_ID=...   # from PayPal Developer Dashboard → Sandbox app → Webhooks
PUBLIC_APP_URL=https://your-public-host   # used for return/cancel URLs
```

Corporate SMTP (existing Accounting mail) must already work for **Send to Customer**.

Credentials stay **server-side only** (`src/config/env.ts` → `config.paypal`). Never put secrets in the frontend.

| Mode | API base |
|------|----------|
| sandbox (default) | `https://api-m.sandbox.paypal.com` |
| live | `https://api-m.paypal.com` |

## Database

New tables (no duplicate Customer/Invoice models):

- `paypal_customer_orders` (`PayPalCustomerOrder`) — order id, amount snapshot, approval URL, status, capture, email audit, idempotency key → `ShipmentLead`
- `paypal_webhook_events` (`PayPalWebhookEvent`) — event id uniqueness for safe duplicates

Amount is always taken from `customerPaymentQuote` on the shipment (customer rate + accessorials + optional 3% fee), never from the request body.

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

Suggested event types: `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.ORDER.COMPLETED`, `CHECKOUT.ORDER.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`.

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

## Out of scope (Phase 1)

Stripe, Cash App, ACH, Wire, Zelle UI, carrier payouts, Customer Portal, unrelated Accounting redesign.
