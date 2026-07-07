#!/usr/bin/env bash
#
# gh-broker — Phase 0 provisioning (RUN AS ROOT).
#
# Creates the isolated service user, the config/creds dirs, encrypts the two
# CLDMV PATs with systemd-creds, and installs the systemd unit. Does NOT deploy
# the app or start the service — see deploy/README.md for build+deploy.
#
# Idempotent: safe to re-run. Re-running the creds step re-encrypts (paste again).
#
# Usage:  sudo ./deploy/provision.sh [AGENT_USER]
#   AGENT_USER: the user your Claude/agent runs as (default: repo). It is added
#               to the gh-broker-clients group so it can reach the socket.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
	echo "must run as root (sudo $0)" >&2
	exit 1
fi

AGENT_USER="${1:-repo}"
SVC_USER="gh-broker"
SVC_GROUP="gh-broker"
CLIENTS_GROUP="gh-broker-clients"
ETC_DIR="/etc/gh-broker"
CREDS_DIR="${ETC_DIR}/creds"
APP_DIR="/opt/gh-broker"
UNIT_SRC="$(cd "$(dirname "$0")" && pwd)/gh-broker.service"
CONFIG_EXAMPLE="$(cd "$(dirname "$0")/.." && pwd)/config.example.json"

echo "==> groups + service user"
getent group "$SVC_GROUP"       >/dev/null || groupadd --system "$SVC_GROUP"
getent group "$CLIENTS_GROUP"   >/dev/null || groupadd --system "$CLIENTS_GROUP"
if ! id "$SVC_USER" >/dev/null 2>&1; then
	useradd --system --gid "$SVC_GROUP" --groups "$CLIENTS_GROUP" \
		--home-dir /nonexistent --shell /usr/sbin/nologin \
		--comment "CLDMV gh-broker service" "$SVC_USER"
else
	usermod --append --groups "$CLIENTS_GROUP" "$SVC_USER"
fi
# Let the agent user reach the socket (member of the clients group).
if id "$AGENT_USER" >/dev/null 2>&1; then
	usermod --append --groups "$CLIENTS_GROUP" "$AGENT_USER"
	echo "    added '$AGENT_USER' to $CLIENTS_GROUP (re-login needed for it to take effect)"
else
	echo "    WARNING: agent user '$AGENT_USER' not found — pass the right one as arg 1" >&2
fi

echo "==> directories"
install -d -o root -g "$SVC_GROUP" -m 0750 "$ETC_DIR"
install -d -o root -g "$SVC_GROUP" -m 0750 "$CREDS_DIR"
install -d -o "$SVC_USER" -g "$SVC_GROUP" -m 0755 "$APP_DIR"

echo "==> config"
if [[ ! -f "${ETC_DIR}/config.json" ]]; then
	install -o root -g "$SVC_GROUP" -m 0640 "$CONFIG_EXAMPLE" "${ETC_DIR}/config.json"
	echo "    installed ${ETC_DIR}/config.json (from config.example.json) — edit owners/tools as needed"
else
	echo "    ${ETC_DIR}/config.json already present — left unchanged"
fi

encrypt_cred() {
	local name="$1" out="${CREDS_DIR}/$1.cred"
	echo
	echo "Paste the ${name} PAT, then press Enter (input hidden):"
	local pat
	IFS= read -rs pat
	echo
	[[ -n "$pat" ]] || { echo "    empty — skipped ${name}"; return 0; }
	# --name binds the ciphertext to this credential id; only this unit can decrypt.
	printf '%s' "$pat" | systemd-creds encrypt --name="${name}" - "$out"
	unset pat
	chmod 0400 "$out"; chown root:root "$out"
	echo "    wrote ${out}"
}

echo "==> encrypt PATs (systemd-creds)"
echo "    fine-grained PAT scopes — see deploy/README.md:"
echo "      cldmv-read : Issues:Read, Pull requests:Read, Contents:Read, Metadata:Read"
echo "      cldmv-write: Issues:R/W, Pull requests:R/W, Contents:R/W, Metadata:Read"
encrypt_cred "cldmv-read"
encrypt_cred "cldmv-write"

echo "==> systemd unit"
install -o root -g root -m 0644 "$UNIT_SRC" /etc/systemd/system/gh-broker.service
systemctl daemon-reload
systemctl enable gh-broker.service >/dev/null
echo "    installed + enabled (not started — deploy the app first)"

cat <<EOF

Phase 0 done. Next (see deploy/README.md):
  1. Build + deploy the app to ${APP_DIR} (as the dev user, then a root copy).
  2. sudo systemctl start gh-broker && systemctl status gh-broker
  3. Point Claude's MCP config at the socket via the stdio bridge.
EOF
