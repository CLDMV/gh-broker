#!/usr/bin/env bash
# Deploy the built app to /opt/gh-broker, sync the unit, and restart (RUN AS ROOT).
# Build first as your dev user:  npm ci && npm run build
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root: sudo $0" >&2; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$SRC/dist/index.mjs" ]] || { echo "no $SRC/dist — run 'npm run build' first" >&2; exit 1; }

# Sync the systemd unit (in case it changed) and reload.
install -m0644 "$SRC/deploy/gh-broker.service" /etc/systemd/system/gh-broker.service
systemctl daemon-reload

# Deploy the built app.
install -d -o gh-broker -g gh-broker -m 0755 /opt/gh-broker
rsync -a --delete "$SRC/dist/" /opt/gh-broker/dist/
chown -R gh-broker:gh-broker /opt/gh-broker

systemctl restart gh-broker
sleep 0.6
systemctl --no-pager --lines=0 status gh-broker | head -4
echo "--- recent log ---"
journalctl -u gh-broker -n 20 --no-pager
