#!/usr/bin/env bash
# Deploy the built app to /opt/gh-broker, sync the unit + config, and restart (RUN AS ROOT).
# Build first as your dev user:  npm ci && npm run build
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root: sudo $0" >&2; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$SRC/dist/index.mjs" ]] || { echo "no $SRC/dist — run 'npm run build' first" >&2; exit 1; }

# Sync the systemd unit and reload.
install -m0644 "$SRC/deploy/gh-broker.service" /etc/systemd/system/gh-broker.service
systemctl daemon-reload

# Sync the config (allowlist + owner->cred-NAME map — NON-secret; PATs live in
# systemd-creds, never here). config.example.json is the source of truth; edit it
# in the repo to change the allowlist or add an org.
install -o root -g gh-broker -m 0640 "$SRC/config.example.json" /etc/gh-broker/config.json

# Deploy the bundled app + the node launcher (resolves node from nvm's `default`
# alias at start, so the unit pins no node version).
install -d -o gh-broker -g gh-broker -m 0755 /opt/gh-broker
install -o gh-broker -g gh-broker -m 0755 "$SRC/deploy/launch.sh" /opt/gh-broker/launch.sh
rsync -a --delete "$SRC/dist/" /opt/gh-broker/dist/
chown -R gh-broker:gh-broker /opt/gh-broker

systemctl restart gh-broker
sleep 0.6
systemctl --no-pager --lines=0 status gh-broker | head -4
echo "--- recent log ---"
journalctl -u gh-broker -n 20 --no-pager
