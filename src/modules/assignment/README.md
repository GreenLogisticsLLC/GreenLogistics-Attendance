# Assignment Engine v1.0

Round-robin shipment assignment based on Attendance + Active + Available.

## Eligibility (all required)

1. **In Office** — linked Employee attendance session `INSIDE_OFFICE`
2. **Active** — `User.isActive = true`
3. **Available for Assignment** — `User.availableForAssignment = true`

## Behavior

- New shipments assigned Round Robin among the current eligible queue
- Leaving the office removes the broker from the queue automatically
- Returning to the office appends the broker to the **end** of the queue
- Queue order + next index persist in `assignment_queue_state`
- Each assignment writes Timeline + `assignment_logs`

## User ↔ Employee link

Set `User.employeeId` (Admin API) or auto-match by first/last name when unique.

```
PATCH /api/assignment/users/:userId/employee  { "employeeId": "..." }
PATCH /api/assignment/users/:userId/available { "availableForAssignment": true }
GET   /api/assignment/queue
GET   /api/assignment/eligible
GET   /api/assignment/logs
```
