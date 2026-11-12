#!/usr/bin/env bash
# Raise nginx multipart upload limit for GreenOS (Accounting invoices, POD, etc.).
# Default nginx client_max_body_size is 1m — scanned invoice PDFs often exceed that → HTML 413.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="${ROOT}/greenos-upload-size.conf"
DEST_DIR="/etc/nginx/conf.d"
DEST="${DEST_DIR}/00-greenos-upload-size.conf"
LIMIT="${GREENOS_UPLOAD_MAX:-50m}"

if ! command -v nginx >/dev/null 2>&1; then
  echo "WARN: nginx not found — skip upload size install"
  exit 0
fi

if [[ ! -d "$DEST_DIR" ]]; then
  echo "WARN: ${DEST_DIR} missing — skip upload size install"
  exit 0
fi

tmp="$(mktemp)"
cat >"$tmp" <<EOF
# Installed by Contabo deploy ($(date -u +%Y-%m-%dT%H:%M:%SZ)).
# Accounting / carrier / POD multipart uploads (scanned PDFs exceed nginx's 1m default).
client_max_body_size ${LIMIT};
EOF

install -m 644 "$tmp" "$DEST"
rm -f "$tmp"
echo "Installed ${DEST} (client_max_body_size ${LIMIT})"

# Also patch known GreenOS site configs if they hardcode a smaller limit.
for conf in \
  /etc/nginx/sites-enabled/* \
  /etc/nginx/sites-available/* \
  /etc/nginx/conf.d/*.conf
do
  [[ -f "$conf" ]] || continue
  [[ "$conf" == "$DEST" ]] && continue
  if grep -Eq 'os\.greengrouplogistics\.com|proxy_pass[[:space:]]+http://127\.0\.0\.1:3847|proxy_pass[[:space:]]+http://localhost:3847' "$conf" 2>/dev/null; then
    if grep -q 'client_max_body_size' "$conf"; then
      sed -i -E "s/client_max_body_size[[:space:]]+[^;]+;/client_max_body_size ${LIMIT};/g" "$conf"
      echo "Updated client_max_body_size in ${conf}"
    else
      # Insert inside the first server { ... } block after the opening brace.
      if grep -q 'server[[:space:]]*{' "$conf"; then
        awk -v lim="$LIMIT" '
          BEGIN { done=0 }
          {
            print
            if (!done && $0 ~ /server[[:space:]]*{/) {
              print "    client_max_body_size " lim ";"
              done=1
            }
          }
        ' "$conf" >"${conf}.tmp" && mv "${conf}.tmp" "$conf"
        echo "Inserted client_max_body_size into ${conf}"
      fi
    fi
  fi
done

if nginx -t 2>&1; then
  systemctl reload nginx 2>/dev/null || service nginx reload 2>/dev/null || nginx -s reload
  echo "nginx reloaded with upload limit ${LIMIT}"
else
  echo "ERROR: nginx -t failed after upload size change"
  nginx -t || true
  exit 1
fi
