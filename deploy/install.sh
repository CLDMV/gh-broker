#!/usr/bin/env bash
#
# OPTIONAL Linux convenience bootstrap. The real installer is the Node one:
#   sudo node deploy/install.mjs [agent-user]
# with node >= 20 as the only prerequisite. This script just gets a system-wide
# node onto the box first (via nvm) for a truly zero-prerequisite run, then hands
# off. Not needed if node is already installed. See docs/deploy-architecture.md.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root: sudo $0 [agent-user]" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"

node_ok() { command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; }

if ! node_ok; then
	echo "==> node >=20 not found — installing system-wide nvm + node"
	export NVM_DIR=/usr/local/nvm
	if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
		command -v git >/dev/null 2>&1 || { echo "git not found — needed to fetch nvm; install git, or install node>=20 yourself then run: sudo node $HERE/install.mjs [agent-user]" >&2; exit 1; }
		git clone --depth 1 https://github.com/nvm-sh/nvm.git "$NVM_DIR"
	fi
	# shellcheck source=/dev/null
	. "$NVM_DIR/nvm.sh"
	nvm install --lts >/dev/null
	nvm alias default node >/dev/null
	ver="$(nvm version default)"
	for b in node npm npx; do ln -sfn "/usr/local/nvm/versions/node/$ver/bin/$b" "/usr/local/bin/$b"; done
fi

exec "$(command -v node)" "$HERE/install.mjs" "$@"
