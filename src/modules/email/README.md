# Email module — Gmail listener + source parsers + shipment pipeline

Architecture:

Gmail → Email Listener → Parser Factory → uShip Parser → ShipmentLead Service → Assignment Engine → Database

Future parsers (DAT, Central Dispatch, Truckstop, Shiply, FreightQuote) plug into `parsers/` without changing the Gmail listener.

API:
- GET  /api/email/auth      — start Gmail OAuth (redirect to Google)
- GET  /api/email/callback  — OAuth callback (saves refresh_token)
- GET  /api/email/shipments
- GET  /api/email/shipments/:id
- POST /api/email/check
- GET  /api/email/logs
- GET  /api/email/status

Mail roles (independent — do not share one mailbox):

| Role | Env | Purpose | Example |
|------|-----|---------|---------|
| 1 Inbound | `GMAIL_*` | uShip import via Gmail API only | `effiegreenlogistics@gmail.com` |
| 2 Approval To: | `APPROVAL_EMAIL` | Owner receives agent signup requests | `osgreenlogistics@gmail.com` |
| 3 Outbound | `SMTP_*` | Send system mail (approval links) | `osgreenlogistics@gmail.com` |

Gmail API env (role 1 only):
- GMAIL_CLIENT_ID
- GMAIL_CLIENT_SECRET
- GMAIL_REFRESH_TOKEN (optional if connected via /api/email/auth)
- GMAIL_USER (import inbox; never use as SMTP sender)
- GMAIL_REDIRECT_URI (optional; default `{PUBLIC_APP_URL}/api/email/callback`)
- GMAIL_PROCESSED_LABEL_ID (optional)
- EMAIL_POLL_INTERVAL_MS (default 30000)

Outbound / approval (roles 2–3) live in root `.env.example` (`APPROVAL_EMAIL`, `SMTP_*`).

Connect Gmail:
1. In Google Cloud Console create OAuth client (Web application).
2. Add authorized redirect URI: `https://os.greengrouplogistics.com/api/email/callback`
3. Set `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` on the server.
4. Open `https://os.greengrouplogistics.com/api/email/auth` and approve access.
5. Refresh token is stored in `settings` (category `gmail`) and applied at runtime.

After deploy: GitHub Actions runs `prisma generate` + `prisma db push` automatically.
If tables are still missing on the server, run once:
`cd /root/GreenLogistics-Attendance && npx prisma db push && pm2 restart greenos`
