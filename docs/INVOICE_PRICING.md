# Invoice Pricing (Handling Fee)

Accounting → **Payment Settings** → Invoice Pricing.

## What this is

GreenOS can add an optional **handling fee** line item on customer invoices and Checkout payment amounts.

- Default: **disabled** (no additional fee).
- Fee types: percentage or fixed USD.
- Applied **consistently across payment methods** when enabled (not PayPal-only).
- Never labeled or charged as a PayPal surcharge / fee for choosing PayPal.
- PayPal’s own processor fees stay **out of** customer invoice totals and are reported separately.

This is **not** the PayPal Invoicing API. GreenOS uses Checkout Orders + GreenOS invoice documents.

## Admin approval

Owner/Administrator must:

1. Choose fee type and value.
2. Check the lawful pricing-policy acknowledgment.
3. Save.

Without acknowledgment, enabling a fee is rejected (`INVOICE_PRICING_POLICY_REQUIRED`).

## Invoice immutability

When Accounting records an invoice (`POST .../invoice` with `confirmPricing: true`), GreenOS locks:

- pricing policy version
- fee type + configured value
- calculated fee, subtotal, total
- full JSON snapshot

Later Payment Settings changes do **not** alter historical invoices. Preview: `GET .../invoice/pricing-preview`.

## Schema (additive)

`ShipmentLead`: `invoice_pricing_version`, `invoice_fee_type`, `invoice_fee_configured_value`, `invoice_fee_amount_usd`, `invoice_subtotal_usd`, `invoice_total_usd`, `invoice_pricing_snapshot_json`.

Settings KV: `settings` category `accounting` / key `invoice_pricing`.
