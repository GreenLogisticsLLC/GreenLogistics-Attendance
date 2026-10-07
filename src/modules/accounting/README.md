# Accounting Team module

First-class Green OS team (`Roles.Accounting`) with two sub-roles only:

- `DOCUMENTS` — verify BOL/POD/RC and financial amounts; mark Ready for Billing / Carrier Payment
- `PAYMENTS` — invoices, customer payments, carrier payments (blocked until Documents verification)

API: `/api/accounting/*` — auth + team + permission + workflow gates.
