# CarrierView GPS integration (Green OS)

## Architecture

```
Green OS Load (ShipmentLead)
   └── TrackingService
          └── TrackingProvider (interface)
                 └── CarrierViewProvider  (implemented)
                 └── Motive / Samsara / Verizon (stubs via registry)
```

- **Token** (`CARRIER_VIEW_API_TOKEN`) stays on the server only.
- **CarrierView load id** (`data.id`) is stored as `ShipmentTracking.providerLoadId`.
- Webhooks are the primary realtime path; reconciliation polls slowly as backup.
- SMS is **not** auto-retried (not idempotent; 5/min).

## Environment

```
CARRIER_VIEW_ENABLED=true
CARRIER_VIEW_API_BASE_URL=https://YOUR-CARRIERVIEW-API-HOST
CARRIER_VIEW_API_TOKEN=...
CARRIER_VIEW_WEBHOOK_SECRET=optional-greenos-only-secret
CARRIER_VIEW_RECONCILIATION_INTERVAL_SECONDS=300
PUBLIC_APP_URL=https://os.greengrouplogistics.com
```

Webhook URLs registered with CarrierView:

- `{PUBLIC_APP_URL}/api/integrations/carrier-view/webhooks/position?k=SECRET`
- `{PUBLIC_APP_URL}/api/integrations/carrier-view/webhooks/load-status?k=SECRET`
- `{PUBLIC_APP_URL}/api/integrations/carrier-view/webhooks/chat?k=SECRET`

CarrierView docs do **not** define HMAC signatures. Green OS uses an optional shared secret in the query string (`?k=`). If `CARRIER_VIEW_WEBHOOK_SECRET` is empty, webhooks are accepted without that check (rely on obscurity of URL + network controls).

## Deploy (manual — do not auto-deploy)

```bash
git pull
npm install
npm run db:push
npm run build
# restart Node process / PM2
# set env vars, then as Admin: Administration → API Integrations → Register webhooks
```

## Load UI

Open Load → **Tracking** → enter driver phone → **Start CarrierView tracking**.
