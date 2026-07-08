#!/bin/bash
# Build + migrate after git sync. Preserves server .env (not in git).

set -e
REPO="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO"

export PATH="/opt/cpanel/ea-nodejs20/bin:/opt/cpanel/ea-nodejs18/bin:$PATH"
NPM="$(command -v npm || echo npm)"

log() { echo "[$(date)] $*"; }

if [ ! -f "$REPO/.env" ]; then
  log "WARN: $REPO/.env missing — copy from .env.example and configure secrets on server."
fi

log "npm ci..."
$NPM ci

log "prisma generate + tsc build..."
$NPM run deploy:build

log "database schema push (no seed)..."
npx prisma db push --skip-generate

mkdir -p "$REPO/tmp"
touch "$REPO/tmp/restart.txt"

log "Build complete."
