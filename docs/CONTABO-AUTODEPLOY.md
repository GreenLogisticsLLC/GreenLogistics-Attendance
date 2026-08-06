# Contabo fallback auto-deploy (when GitHub Actions is down)

Primary deploy is still **GitHub Actions** (`.github/workflows/deploy.yml`).

This watcher runs on the Contabo VPS and pulls `origin/main` every 2 minutes if Actions cannot create runs.

## Files

| Repo path | Installed on VPS |
|-----------|------------------|
| `tools/contabo-autodeploy/greenos-autodeploy.sh` | `/usr/local/bin/greenos-autodeploy.sh` |
| `tools/contabo-autodeploy/greenos-autodeploy.service` | `/etc/systemd/system/greenos-autodeploy.service` |
| `tools/contabo-autodeploy/greenos-autodeploy.timer` | `/etc/systemd/system/greenos-autodeploy.timer` |

## Install (once, on Contabo as root)

```bash
cd /root/GreenLogistics-Attendance
git fetch origin && git reset --hard origin/main
bash tools/contabo-autodeploy/install-greenos-autodeploy.sh
```

## Behavior

1. `git fetch origin`
2. Compare `HEAD` vs `origin/main`
3. Same → **still** run health gate (below), then exit
4. Different → save `last-working-commit.txt`, `reset --hard`, `npm ci`, `db:push`, `build`, `pm2 restart`, health check
5. Success → log `deploy successful`
6. Failure → rollback to `last-working-commit.txt` and log

### Health gate (every tick)

1. Check PM2 process `greenos` is online
2. `GET http://localhost:3847/api/health`
3. If health fails → `npm run build`, `pm2 restart greenos --update-env`, retry health

Concurrency: `flock` on `/var/lock/greenos-autodeploy.lock`.

Logs: `/var/log/greenos-autodeploy.log` and `journalctl -u greenos-autodeploy.service`.

## Useful commands

```bash
systemctl status greenos-autodeploy.timer
systemctl start greenos-autodeploy.service   # one-shot now
tail -f /var/log/greenos-autodeploy.log
```
