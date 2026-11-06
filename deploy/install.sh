#!/usr/bin/env bash
#
# Install or upgrade gh-broker from a checkout:
#   sudo ./deploy/install.sh [agent-user] [flags]
# Gets a system-wide node onto the box first if there is none (via nvm), builds the
# checkout as its owner (never as root), then runs the installer from the build:
# bin/gh-broker.mjs install. Flags are the installer's (see --help). From the npm
# package nothing is built: sudo gh-broker install. See docs/deploy-architecture.md.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root: sudo $0 [agent-user]" >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

node_ok() { command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; }

if ! node_ok; then
	echo "==> node >=22 not found — installing system-wide nvm + node"
	export NVM_DIR=/usr/local/nvm
	if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
		command -v git >/dev/null 2>&1 || { echo "git not found — needed to fetch nvm; install git, or install node>=22 yourself, then re-run" >&2; exit 1; }
		git clone --depth 1 https://github.com/nvm-sh/nvm.git "$NVM_DIR"
	fi
	# nvm reads unset variables, so -u is off while it runs.
	set +u
	# shellcheck source=/dev/null
	. "$NVM_DIR/nvm.sh"
	nvm install --lts >/dev/null
	nvm alias default node >/dev/null
	ver="$(nvm version default)"
	set -u
	for b in node npm npx; do ln -sfn "/usr/local/nvm/versions/node/$ver/bin/$b" "/usr/local/bin/$b"; done
fi
command -v npm >/dev/null 2>&1 || { echo "npm not found — needed to build the checkout" >&2; exit 1; }

# Build as whoever owns the checkout. sudo -u '#<uid>' gives that user's home and groups,
# so nothing in the checkout ends up owned by root. Output with anything in it owned by
# someone else (a manual `sudo npm run build` or `sudo npm install`) is removed first, so
# the build can replace it.
owner="$(stat -c %u "$ROOT/package.json")"
[[ "$owner" != 0 ]] || { echo "the checkout is owned by root; chown it to a normal user first (or install the npm package)" >&2; exit 1; }
for d in dist bin node_modules; do
	if [[ -e "$ROOT/$d" && -n "$(find "$ROOT/$d" ! -uid "$owner" -print -quit)" ]]; then
		echo "==> $d/ has files owned by another user — removing it to rebuild"
		rm -rf "${ROOT:?}/$d"
	fi
done
as_owner() { (cd "$ROOT" && sudo -u "#$owner" "$@"); }
# Reinstall dependencies when the lockfile is newer than the last install (a pulled
# checkout), not only when node_modules is missing. npm writes node_modules/.package-lock.json
# on every install; it isn't byte-identical to package-lock.json, so compare times.
[[ "$ROOT/node_modules/.package-lock.json" -nt "$ROOT/package-lock.json" ]] || as_owner npm ci
echo "==> build"
as_owner npm run build

exec "$(command -v node)" "$ROOT/bin/gh-broker.mjs" install "$@"
