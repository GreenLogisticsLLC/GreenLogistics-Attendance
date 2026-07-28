# Shipment Aggregate (Sprint A)

Green OS treats **one Shipment** as the permanent Aggregate Root.

```
uShip email → Import → Shipment Card (GOS-…) → Assignment → Broker → Accept → Load # → Dispatch → Closed
```

## Rules

1. **One Shipment = one Shipment Card** (`shipment_leads` row). Never create a second record after Accept.
2. **Load Number** is a field on the same card (`load_number`). There is no Load entity.
3. **Green OS Shipment ID** (`green_os_shipment_id`, e.g. `GOS-20260728-0001`) is allocated once and never changes.
4. **Domain Events** (`domain_events`) are the source of truth; Timeline is projected from them.

## Lifecycle

```
NEW → BID_SUBMITTED → CUSTOMER_REPLIED → ACCEPTED → LOAD_CREATED → DISPATCH → COMPLETED → CLOSED
```

Assignment Engine statuses (`UNASSIGNED`, `AWAITING_ACCEPTANCE`, `WORKING`) coexist on the same status field.

## API

```
GET  /api/shipments/:id
POST /api/shipments/:id/load-number   { "loadNumber": "LN-123" }
GET  /api/shipments/:id/events
```

CRM card endpoints remain at `/api/crm/shipments/:id`.
