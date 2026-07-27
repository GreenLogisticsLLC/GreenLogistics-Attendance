# GreenOS Roles

Central definitions: `src/auth/roles.ts`

## Current signup roles (approval required)

| Role | Access |
|------|--------|
| **Broker** | My Workspace only (Personal Dashboard, My Shipments, My Customers, Notifications). API scoped to own shipments → 403 otherwise. |
| **Team Lead** | CRM + Email + Attendance + Reports |
| **Manager** | Company operations (CRM, Email, Dispatch, Attendance…) |
| **Owner** | Full access + Administration |

## Future roles (seeded, MODULE_ACCESS ready)

Dispatcher, HR, Accounting, Administrator, Viewer

## Broker registration

1. Sign Up → role **Broker**
2. Email to `APPROVAL_EMAIL` (default: `effiegreenlogistics@gmail.com`) via `SMTP_*` — open that Gmail and Approve/Reject
3. Approve link → User created with Broker role
4. Login → broker shell only

uShip mail still arrives on the same `GMAIL_USER` inbox and is imported into the Email module on the platform.

## Changing roles after approval

Owner / Administrator / Manager / HR can open **Employees → Platform users** and change a user’s role
(e.g. Broker → Team Lead). The person must sign in again for the new menu to apply.
Only Owner/Administrator may assign Owner or Administrator. The last active Owner cannot be demoted.

**Delete** removes the account and related GreenOS data: assigned CRM shipments, assignment queue entry,
audit logs, pending signup rows, and a linked attendance badge employee (sessions/events) if linked.
You cannot delete your own account or the last Owner.

1. Add role to `Roles` + `MODULE_ACCESS` in `roles.ts`
2. Add `roles: [...]` on registry entries in `frontend/public/modules/registry.js`
3. Seed the role in `prisma/seed.ts`
4. Add to `SIGNUP_ROLE_NAMES` if self-registration allowed
