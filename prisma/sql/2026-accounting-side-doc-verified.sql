-- Accounting: customer / carrier document verification sides.
-- Load enters Verified only when both timestamps are set (service also sets accounting_doc_status).

ALTER TABLE shipment_leads
  ADD COLUMN IF NOT EXISTS accounting_customer_docs_verified_at TIMESTAMP NULL;

ALTER TABLE shipment_leads
  ADD COLUMN IF NOT EXISTS accounting_carrier_docs_verified_at TIMESTAMP NULL;

-- Legacy fully-verified loads: treat both sides as already checked.
UPDATE shipment_leads
SET
  accounting_customer_docs_verified_at = COALESCE(
    accounting_customer_docs_verified_at,
    accounting_doc_verified_at,
    NOW()
  ),
  accounting_carrier_docs_verified_at = COALESCE(
    accounting_carrier_docs_verified_at,
    accounting_doc_verified_at,
    NOW()
  )
WHERE UPPER(COALESCE(accounting_doc_status, '')) = 'VERIFIED'
  AND (
    accounting_customer_docs_verified_at IS NULL
    OR accounting_carrier_docs_verified_at IS NULL
  );
