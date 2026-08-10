#!/bin/bash
# Fast deploy hook for cPanel Git "Deploy HEAD Commit" (.cpanel.yml).
# Node build runs separately via cron — npm here causes UI timeout/hang.
set -e
REPO="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO"

HEAD="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "$HEAD" > "$REPO/deploy-version.txt"
echo "$HEAD" > "$REPO/frontend/public/deploy-version.txt" 2>/dev/null || true
echo "Git deploy hook OK: $HEAD (build via cron)"
