# Email module — Gmail listener + source parsers + shipment pipeline

Architecture:

Gmail → Email Listener → Parser Factory → uShip Parser → ShipmentLead Service → Assignment Engine → Database

Future parsers (DAT, Central Dispatch, Truckstop, Shiply, FreightQuote) plug into `parsers/` without changing the Gmail listener.

API:
- GET  /api/email/shipments
- GET  /api/email/shipments/:id
- POST /api/email/check
- GET  /api/email/logs
- GET  /api/email/status

Env:
- GMAIL_CLIENT_ID
- GMAIL_CLIENT_SECRET
- GMAIL_REFRESH_TOKEN
- GMAIL_USER
- GMAIL_PROCESSED_LABEL_ID (optional)
- EMAIL_POLL_INTERVAL_MS (default 30000)

After deploy, run once on server:
`npx prisma db push`
