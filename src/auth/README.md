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
2. Email to `APPROVAL_EMAIL` (Owner inbox), sent via `SMTP_*` (not via `GMAIL_USER`)
3. Approve link → User created with Broker role
4. Login → broker shell only

## Extending

1. Add role to `Roles` + `MODULE_ACCESS` in `roles.ts`
2. Add `roles: [...]` on registry entries in `frontend/public/modules/registry.js`
3. Seed the role in `prisma/seed.ts`
4. Add to `SIGNUP_ROLE_NAMES` if self-registration allowed
