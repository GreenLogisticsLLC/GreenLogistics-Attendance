# Assignment Engine v1.0

```
Attendance (card swipe)
    ↓
In Office / Out of Office
    ↓
Assignment Queue (Round Robin)
    ↓
CRM Shipment
```

## Rule (only Attendance)

| Card / status   | Effect                                      |
|-----------------|---------------------------------------------|
| **In Office**   | Automatically joins end of assignment queue; pending Unassigned/NEW leads are drained via Round Robin |
| **Out of Office** | Immediately removed — no new shipments    |

No toggles, buttons, or checkboxes.

## Status flow

```
NEW → (no broker) UNASSIGNED
    → ASSIGNED → AWAITING_ACCEPTANCE → WORKING (Accept)
```

## Morning example

Alex → Leah → David → Mary swipe In Office  
Queue: `1 Alex → 2 Leah → 3 David → 4 Mary`  
Shipments #1–#4 go to each in turn; #5 back to Alex.

Alex leaves → Out of Office → removed  
Queue: `Leah → David → Mary`  
Next shipment → Leah.

## API

```
GET /api/assignment/queue
GET /api/assignment/eligible
GET /api/assignment/logs
POST /api/assignment/drain-pending
PATCH /api/assignment/users/:userId/employee  { "employeeId": "..." }
GET /api/crm/events?token=…   — SSE live assignment notifications
```

Live notify: after Round Robin assign, broker receives `SHIPMENT_ASSIGNED` over SSE (toast + optional sound). Managers get `SHIPMENT_UNASSIGNED` / broadcast events.

Link User ↔ Employee once (or rely on unique first/last name match).
