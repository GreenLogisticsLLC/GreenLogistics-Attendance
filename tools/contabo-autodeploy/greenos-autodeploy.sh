#!/usr/bin/env bash
# GreenOS Contabo auto-deploy watcher (FALLBACK only).
# Primary deploy remains GitHub Actions → SSH.
# Polls origin/main every ~2 minutes (via systemd timer) and deploys when ahead.
#
# Install path on VPS: /usr/local/bin/greenos-autodeploy.sh
# Lock:            /var/lock/greenos-autodeploy.lock
# Log:             /var/log/greenos-autodeploy.log

set -euo pipefail

APP_DIR="${GREENOS_APP_DIR:-/root/GreenLogistics-Attendance}"
LOG_FILE="${GREENOS_AUTODEPLOY_LOG:-/var/log/greenos-autodeploy.log}"
LOCK_FILE="${GREENOS_AUTODEPLOY_LOCK:-/var/lock/greenos-autodeploy.lock}"
BACKUP_COMMIT_FILE="${APP_DIR}/last-working-commit.txt"
HEALTH_URL="${GREENOS_HEALTH_URL:-http://localhost:3847/api/health}"
BRANCH="${GREENOS_DEPLOY_BRANCH:-main}"
REMOTE="${GREENOS_DEPLOY_REMOTE:-origin}"

# Ensure common root PATH for npm / pm2 / node (non-login systemd units).
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$LOCK_FILE")"

log() {
  local msg="$*"
  printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$msg" | tee -a "$LOG_FILE" >/dev/null
}

# Never run two deployments at once (timer overlap + manual runs).
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "SKIP locked — another greenos-autodeploy is already running"
  exit 0
fi

log "==== autodeploy start (fallback watcher; GitHub Actions is primary) ===="

if [[ ! -d "$APP_DIR/.git" ]]; then
  log "ERROR app dir missing or not a git repo: $APP_DIR"
  exit 1
fi

cd "$APP_DIR"

log "Fetching ${REMOTE}…"
if ! git fetch "$REMOTE" --prune >>"$LOG_FILE" 2>&1; then
  log "ERROR git fetch failed"
  exit 1
fi

LOCAL="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "${REMOTE}/${BRANCH}")"

log "LOCAL=${LOCAL}"
log "REMOTE=${REMOTE_SHA} (${REMOTE}/${BRANCH})"

if [[ "$LOCAL" == "$REMOTE_SHA" ]]; then
  log "OK already up to date — exit"
  exit 0
fi

log "DIFF detected — deploying ${LOCAL:0:7} → ${REMOTE_SHA:0:7}"

# Remember last known-good commit before mutating the tree.
printf '%s\n' "$LOCAL" >"$BACKUP_COMMIT_FILE"
log "Backup commit written to ${BACKUP_COMMIT_FILE}: ${LOCAL}"

rollback() {
  local reason="${1:-deploy failed}"
  local prev
  prev="$(tr -d '[:space:]' <"$BACKUP_COMMIT_FILE" 2>/dev/null || true)"
  if [[ -z "$prev" ]]; then
    log "ROLLBACK aborted — no commit in ${BACKUP_COMMIT_FILE} (${reason})"
    return 1
  fi
  log "ROLLBACK begin → ${prev} (${reason})"
  git reset --hard "$prev" >>"$LOG_FILE" 2>&1 || {
    log "ERROR rollback git reset --hard failed"
    return 1
  }
  if ! npm ci >>"$LOG_FILE" 2>&1; then
    log "ERROR rollback npm ci failed"
    return 1
  fi
  if ! npm run build >>"$LOG_FILE" 2>&1; then
    log "ERROR rollback npm run build failed"
    return 1
  fi
  pm2 restart greenos --update-env >>"$LOG_FILE" 2>&1 || {
    log "ERROR rollback pm2 restart failed"
    return 1
  }
  pm2 save >>"$LOG_FILE" 2>&1 || true
  log "ROLLBACK complete → $(git rev-parse --short HEAD)"
  return 0
}

set +e
(
  set -euo pipefail
  log "STEP git reset --hard ${REMOTE}/${BRANCH}"
  git reset --hard "${REMOTE}/${BRANCH}" >>"$LOG_FILE" 2>&1
  log "STEP npm ci"
  npm ci >>"$LOG_FILE" 2>&1
  log "STEP npm run db:push"
  npm run db:push >>"$LOG_FILE" 2>&1
  log "STEP npm run build"
  npm run build >>"$LOG_FILE" 2>&1
  log "STEP pm2 restart greenos --update-env"
  pm2 restart greenos --update-env >>"$LOG_FILE" 2>&1
  pm2 save >>"$LOG_FILE" 2>&1
  log "STEP health wait 5s then curl ${HEALTH_URL}"
  sleep 5
  curl --fail --silent --show-error --max-time 30 "$HEALTH_URL" >>"$LOG_FILE" 2>&1
)
deploy_status=$?
set -e

if [[ $deploy_status -eq 0 ]]; then
  git rev-parse --short HEAD >"${APP_DIR}/deploy-version.txt" 2>/dev/null || true
  log "deploy successful"
  log "OK health check passed at ${HEALTH_URL} — now at $(git rev-parse --short HEAD)"
  exit 0
fi

log "ERROR deploy failed (exit=${deploy_status}) — starting rollback"
if rollback "deploy/health failed with exit ${deploy_status}"; then
  log "deploy failed; rollback successful"
  exit 1
fi

log "CRITICAL deploy failed and rollback failed"
exit 1
