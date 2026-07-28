# Email module

## Company Gmail (import)
- OAuth: `GET /api/email/auth` → company mailbox (new uShip shipments)
- Poll: unread → ParserFactory → Shipment create → Assignment

## Broker Gmail (Sprint C)
- OAuth per broker: `GET /api/email/broker/auth?json=1` (JWT)
- Stored in `broker_gmail_accounts`
- Sync polls only `from:uship.com` — personal mail ignored / not stored
- History: `broker_mailbox_messages` linked to broker + optional `shipment_lead_id`
- Scheduler runs company inbox + all active broker mailboxes

Gmail is a **sync source only** — not a GreenOS mail client.
