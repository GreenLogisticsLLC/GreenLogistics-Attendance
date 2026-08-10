# GitHub + auto-deploy to so.greengrouplogistics.com

Production URL: **https://so.greengrouplogistics.com**

See Russian step-by-step guide: **`docs/DEPLOY-SO-SUBDOMAIN.ru.md`**

## Repository

```
https://github.com/GreenLogisticsLLC/GreenLogistics-Attendance
```

## Local workflow

```bash
git add .
git commit -m "description"
git push origin main
```

cPanel cron syncs `origin/main` every 5 minutes (same pattern as GreenGroup / SeoGeo).

## cPanel paths

| Item | Path |
|------|------|
| Git repo | `/home/ijh19zqesepn/repositories/GreenLogistics-Attendance` |
| Cron script | `tools/cpanel-cron-deploy.sh` |
| Node.js URL | `so.greengrouplogistics.com` |
| Startup file | `dist/index.js` |

## Health check

```
GET https://so.greengrouplogistics.com/api/health
```

Response field `commit` should match the latest GitHub push.
