#!/usr/bin/env bash
# GreenOS Contabo auto-deploy watcher (FALLBACK only).
# Primary deploy remains GitHub Actions → SSH.
# Polls origin/main every ~2 minutes (via systemd timer) and deploys when ahead.
# Every run (even when commits match): verify PM2 + /api/health; self-heal if down.
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
PM2_APP="${GREENOS_PM2_APP:-greenos}"

# Ensure common root PATH for npm / pm2 / node (non-login systemd units).
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$LOCK_FILE")"

log() {
  local msg="$*"
  printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$msg" | tee -a "$LOG_FILE" >/dev/null
}

health_ok() {
  curl --fail --silent --show-error --max-time 30 "$HEALTH_URL" >>"$LOG_FILE" 2>&1
}

# True if PM2 knows the process and status is online.
pm2_greenos_online() {
  if ! command -v pm2 >/dev/null 2>&1; then
    log "ERROR pm2 not found on PATH"
    return 1
  fi
  if ! pm2 describe "$PM2_APP" >>"$LOG_FILE" 2>&1; then
    log "WARN PM2: process '${PM2_APP}' is not registered"
    return 1
  fi
  # pm2 pid returns empty / errors when stopped
  local pid
  pid="$(pm2 pid "$PM2_APP" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -z "$pid" || "$pid" == "0" ]]; then
    log "WARN PM2: process '${PM2_APP}' is not online (pid=${pid:-empty})"
    return 1
  fi
  log "OK PM2: ${PM2_APP} online (pid=${pid})"
  return 0
}

pm2_restart_or_start() {
  log "STEP pm2 restart ${PM2_APP} --update-env (with OPENAI_* from .env)"
  # shellcheck disable=SC1091
  if [[ -f "${APP_DIR}/tools/pm2-greenos-env.sh" ]]; then
    source "${APP_DIR}/tools/pm2-greenos-env.sh" "${APP_DIR}/.env"
  fi
  if pm2 restart "$PM2_APP" --update-env >>"$LOG_FILE" 2>&1; then
    pm2 save >>"$LOG_FILE" 2>&1 || true
    return 0
  fi
  log "WARN pm2 restart failed — trying pm2 start"
  # Prefer compiled entry used in production Contabo deploys.
  if [[ -f "${APP_DIR}/dist/index.js" ]]; then
    pm2 start "${APP_DIR}/dist/index.js" --name "$PM2_APP" --update-env --cwd "$APP_DIR" >>"$LOG_FILE" 2>&1 \
      || pm2 start npm --name "$PM2_APP" -- start >>"$LOG_FILE" 2>&1
  else
    pm2 start npm --name "$PM2_APP" -- start >>"$LOG_FILE" 2>&1
  fi
  pm2 save >>"$LOG_FILE" 2>&1 || true
}

# After every watcher tick (including when LOCAL == REMOTE):
# 1) Check PM2 greenos
# 2) GET health
# 3) If health fails → build, restart, re-check health
ensure_greenos_healthy() {
  log "==== runtime health gate ===="
  set +e
  pm2_greenos_online
  local pm2_status=$?

  log "STEP GET ${HEALTH_URL}"
  if health_ok; then
    log "OK health check passed"
    if [[ $pm2_status -ne 0 ]]; then
      log "WARN health OK but PM2 status looked bad — process may be external; continuing"
    fi
    set -e
    return 0
  fi

  log "WARN health check FAILED — self-heal: npm ci (if needed), build, pm2 restart"
  cd "$APP_DIR"
  if [[ ! -d node_modules ]] || [[ ! -x node_modules/.bin/tsc ]]; then
    log "STEP self-heal npm ci (node_modules missing or incomplete)"
    if ! npm ci >>"$LOG_FILE" 2>&1; then
      log "WARN self-heal npm ci failed — trying npm install"
      rm -rf node_modules
      npm install --no-audit --no-fund >>"$LOG_FILE" 2>&1 || {
        log "ERROR self-heal npm install failed"
        set -e
        return 1
      }
    fi
  fi
  if ! npm run build >>"$LOG_FILE" 2>&1; then
    log "ERROR self-heal npm run build failed"
    set -e
    return 1
  fi
  pm2_restart_or_start
  log "STEP health wait 5s then retry GET ${HEALTH_URL}"
  sleep 5
  if health_ok; then
    log "OK health check passed after self-heal"
    set -e
    return 0
  fi
  log "ERROR health check still failing after self-heal"
  set -e
  return 1
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
  log "OK already up to date — skipping git deploy, running health gate"
  if ensure_greenos_healthy; then
    log "==== autodeploy done (no git change, healthy) ===="
    exit 0
  fi
  log "==== autodeploy done (no git change, UNHEALTHY) ===="
  exit 1
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
  pm2_restart_or_start || {
    log "ERROR rollback pm2 restart failed"
    return 1
  }
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
  # shellcheck disable=SC1091
  if [[ -f "${APP_DIR}/tools/pm2-greenos-env.sh" ]]; then
    source "${APP_DIR}/tools/pm2-greenos-env.sh" "${APP_DIR}/.env"
  fi
  log "STEP pm2 restart ${PM2_APP} --update-env"
  pm2 restart "$PM2_APP" --update-env >>"$LOG_FILE" 2>&1
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
  # Extra PM2 + health gate after successful deploy (same path as idle ticks).
  ensure_greenos_healthy || true
  exit 0
fi

log "ERROR deploy failed (exit=${deploy_status}) — starting rollback"
if rollback "deploy/health failed with exit ${deploy_status}"; then
  ensure_greenos_healthy || true
  log "deploy failed; rollback successful"
  exit 1
fi

log "CRITICAL deploy failed and rollback failed"
exit 1
