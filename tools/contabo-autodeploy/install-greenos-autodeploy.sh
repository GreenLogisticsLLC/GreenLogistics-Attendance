#!/usr/bin/env bash
# Install GreenOS Contabo auto-deploy fallback on this VPS.
# Run as root on Contabo:
#   bash /root/GreenLogistics-Attendance/tools/contabo-autodeploy/install-greenos-autodeploy.sh
#
# Or from a fresh clone of this folder after copying files into place.

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: run as root" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_SH="${SCRIPT_DIR}/greenos-autodeploy.sh"
SRC_SERVICE="${SCRIPT_DIR}/greenos-autodeploy.service"
SRC_TIMER="${SCRIPT_DIR}/greenos-autodeploy.timer"

for f in "$SRC_SH" "$SRC_SERVICE" "$SRC_TIMER"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: missing $f" >&2
    exit 1
  fi
done

install -d -m 755 /usr/local/bin
install -m 755 "$SRC_SH" /usr/local/bin/greenos-autodeploy.sh
install -m 644 "$SRC_SERVICE" /etc/systemd/system/greenos-autodeploy.service
install -m 644 "$SRC_TIMER" /etc/systemd/system/greenos-autodeploy.timer

touch /var/log/greenos-autodeploy.log
chmod 644 /var/log/greenos-autodeploy.log

systemctl daemon-reload
systemctl enable --now greenos-autodeploy.timer

echo "Installed Contabo fallback auto-deploy."
echo "  script:  /usr/local/bin/greenos-autodeploy.sh"
echo "  service: greenos-autodeploy.service"
echo "  timer:   greenos-autodeploy.timer (OnBootSec=2min, OnUnitActiveSec=2min)"
echo "  log:     /var/log/greenos-autodeploy.log"
echo
systemctl status greenos-autodeploy.timer --no-pager || true
systemctl list-timers greenos-autodeploy.timer --no-pager || true
echo
echo "Manual one-shot: systemctl start greenos-autodeploy.service"
echo "Tail logs:       journalctl -u greenos-autodeploy.service -f"
echo "                 tail -f /var/log/greenos-autodeploy.log"
echo
echo "NOTE: GitHub Actions remains the primary deploy path. This timer is fallback only."
