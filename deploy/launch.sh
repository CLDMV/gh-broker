#!/usr/bin/env bash
#
# gh-broker node launcher.
#
# Resolves the node binary from the SYSTEM-WIDE nvm's `default` alias and execs
# whatever it is handed (the broker + args, from the unit's ExecStart). This
# keeps the systemd unit free of a pinned node version: bump node with
# `nvm install --lts` / `nvm alias default <ver>` (or just install a newer one —
# `default` tracks `node`, the latest installed) and the next
# `systemctl restart gh-broker` picks it up. No unit edit, no path to update.
#
# Why a wrapper and not a bare `node` on PATH: the service runs jailed
# (ProtectHome=true, home=/nonexistent), so a per-user ~/.nvm under /home is
# unreachable by design, and there is no login shell at start to run nvm's PATH
# shim. We point NVM_DIR at the shared /usr/local/nvm and resolve `default`
# ourselves, so the service and an interactive CLI (pointed at the same NVM_DIR)
# run the exact same node binary.
set -euo pipefail

export NVM_DIR="${NVM_DIR:-/usr/local/nvm}"
export HOME="${HOME:-/nonexistent}" # jailed service user has no real home; keep nvm from probing one

if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
	echo "gh-broker: no nvm at NVM_DIR=$NVM_DIR — install nvm system-wide (see deploy/README.md)." >&2
	exit 1
fi

# --no-use: define nvm's shell functions without switching the current version.
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh" --no-use

node_bin="$(nvm which default 2>/dev/null || true)"
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
	echo "gh-broker: could not resolve a node from nvm's 'default' alias (NVM_DIR=$NVM_DIR)." >&2
	echo "  set one:  nvm install --lts && nvm alias default node" >&2
	exit 1
fi

exec "$node_bin" "$@"
