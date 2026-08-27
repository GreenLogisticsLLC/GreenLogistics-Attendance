# Assignment Engine — Sprint B (complete)

```
Attendance (card swipe)
    ↓
In Office / Out of Office   ← only these two for eligibility
    ↓
Assignment Queue (Round Robin)
    ↓
Shipment Card + Domain Event BROKER_ASSIGNED
    ↓
SSE: "New Shipment Assigned — GOS-…"
```

## Rules

| Card / status   | Effect |
|-----------------|--------|
| **In Office**   | Joins end of queue; drains Unassigned/NEW via Round Robin |
| **Out of Office** | Removed immediately — skipped |

No Busy / Away / Available toggles. `availableForAssignment` on User is ignored by the engine (In Office from Attendance is the only gate).

## Notification

On assign, broker receives live SSE:

- Title: **New Shipment Assigned**
- Body: **Shipment # GOS-YYYYMMDD-####** + route summary

Managers get `SHIPMENT_ASSIGNED_BROADCAST`.

## API

```
GET  /api/assignment/queue
GET  /api/assignment/eligible
GET  /api/assignment/logs
POST /api/assignment/drain-pending
PATCH /api/assignment/users/:userId/employee
GET  /api/crm/events?token=…
```
