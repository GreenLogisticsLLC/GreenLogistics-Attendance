#!/bin/bash
# cPanel Cron (every 5 min) — same pattern as GreenGroup / SeoGeo:
# /bin/bash /home/ijh19zqesepn/repositories/GreenLogistics-Attendance/tools/cpanel-cron-deploy.sh

REPO="/home/ijh19zqesepn/repositories/GreenLogistics-Attendance"
LOG="$REPO/deploy-check.txt"

log() { echo "[$(date)] $*" >> "$LOG"; }

if [ ! -d "$REPO/.git" ]; then
  log "ERROR: repo not found at $REPO — clone GreenLogistics-Attendance in cPanel Git first."
  exit 1
fi

cd "$REPO" || { log "ERROR: cannot cd to $REPO"; exit 1; }

GIT="$(command -v git || echo /usr/local/cpanel/3rdparty/bin/git)"
$GIT fetch origin main 2>>"$LOG" || { log "ERROR: git fetch failed"; exit 1; }
$GIT reset --hard origin/main 2>>"$LOG" || { log "ERROR: git reset failed"; exit 1; }

HEAD="$($GIT rev-parse --short HEAD 2>/dev/null || echo unknown)"
log "Synced to $HEAD"

if [ -x /usr/local/cpanel/bin/git_deploy ]; then
  /usr/local/cpanel/bin/git_deploy "$REPO" >>"$LOG" 2>&1 || log "WARN: git_deploy failed, running build script"
fi

/bin/bash "$REPO/tools/cpanel-deploy-build.sh" >>"$LOG" 2>&1 || { log "ERROR: build failed"; exit 1; }

echo "$HEAD" > "$REPO/deploy-version.txt"
echo "$HEAD" > "$REPO/frontend/public/deploy-version.txt"
echo "Deployed $HEAD at $(date)" >> "$LOG"
log "Deploy complete: $HEAD"
