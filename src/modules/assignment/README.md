# Assignment Engine v1.0

Round-robin shipment assignment driven **only by Attendance**.

## Eligibility

| Attendance status | In assignment queue |
|-------------------|---------------------|
| **In Office**     | Yes                 |
| **Out of Office** | No (removed immediately) |

No manual Active / Available switches. Card swipe (or status change) is enough.

## Behavior

- New shipments → Round Robin among brokers currently In Office
- Out of Office → excluded from queue, receives no new shipments
- Back In Office → appended to the **end** of the queue
- Queue order + next index persist in `assignment_queue_state`
- Each assignment writes Timeline + `assignment_logs`

## User ↔ Employee link

Needed so Attendance can be read for a broker login account.

Auto-match by first/last name when unique, or:

```
PATCH /api/assignment/users/:userId/employee  { "employeeId": "..." }
GET   /api/assignment/queue
GET   /api/assignment/eligible
GET   /api/assignment/logs
```
