# Deploying gh-broker

Phase 0 (provisioning) runs as **root** and is the only privileged step. Everything else runs as the unprivileged dev user. Section 0 below is the host prerequisites — do it once per machine before provisioning.

The broker is designed to run as a **dedicated service user, separate from the unprivileged user the agent runs as** — that two-user split is the security boundary. The users, the bridge group, and the permissions that enforce it are documented, with a reproducible example setup, in [`../docs/agent-user-model.md`](../docs/agent-user-model.md). Read it before choosing which user your agent runs as (§2 wires that user into the socket's bridge group).

## 0. Host prerequisites

A systemd host with `systemd-creds` (systemd ≥ 250) for the encrypted credential store, plus these tools on `PATH`: `git`, `rsync`, `socat` (the agent's stdio↔socket bridge), and `npm` for the build. Install whatever's missing from the distro (`apt install socat rsync git` etc.).

### Node — one system-wide nvm, shared by the CLI and the jailed service

The broker runs jailed: service user `gh-broker`, `--home-dir /nonexistent`, and `ProtectHome=true` in the unit. Two consequences drive the whole node setup:

- A per-user nvm under `/home` (`~/.nvm`) is **invisible** to the service — `ProtectHome` masks `/home` by design.
- There is **no login shell** at service start, so nvm's usual PATH shim (`nvm use` rewriting `$PATH`) never runs — the service can't just "find node on PATH."

The fix is a **single system-wide nvm at `/usr/local/nvm`** (`NVM_DIR`), owned by root and world-readable, with a `default` alias. Both the interactive CLI user and the service resolve node from that same install, so the CLI's `node` and the service's `node` are the **same binary** — bump one and both move. No node version is pinned anywhere:

- The **service** gets `NVM_DIR=/usr/local/nvm` from the unit and runs `deploy/launch.sh`, which sources the system nvm and execs `nvm which default`. Bump node with `nvm install --lts` / `nvm alias default <ver>` (or just install a newer one — `default` tracks `node`, the latest installed) and the next `systemctl restart gh-broker` picks it up. Nothing to edit.
- The **interactive users** (every human account) should resolve node from the *same* install so nothing drifts. Do this **server-wide**, not by editing one person's `~/.bashrc` — a per-user rc edit fixes only that one account, and a personal `export NVM_DIR="$HOME/.nvm"` block in someone's rc will *shadow* the shared install for them. Two root steps cover every shell:

  ```sh
  # a) every login shell gets the shared nvm (and the `nvm` command itself)
  sudo tee /etc/profile.d/nvm.sh >/dev/null <<'EOF'
  export NVM_DIR=/usr/local/nvm
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  EOF

  # b) point the system node/npm/npx at the shared nvm, so EVERY shell (login or
  #    not) gets the same binary on PATH via /usr/local/bin
  ver="$(NVM_DIR=/usr/local/nvm bash -c '. "$NVM_DIR/nvm.sh" --no-use && nvm version default')"
  for b in node npm npx; do sudo ln -sfn "/usr/local/nvm/versions/node/$ver/bin/$b" "/usr/local/bin/$b"; done
  ```

  Then, on any account that *already* sources a personal `~/.nvm` in its rc (it overrides the shared install for that user), remove that block — in that user's own shell: `grep -nE 'HOME/\.nvm|\.nvm/nvm\.sh' ~/.bashrc` and delete the matches; optionally `rm -rf ~/.nvm`. Afterward `readlink -f "$(which node)"` and `nvm which default` should print the same `/usr/local/nvm/versions/node/<ver>/bin/node` for every user and the service.

Install nvm system-wide (once, as root — node ≥ 20 is required; the daemon targets node20):

```sh
export NVM_DIR=/usr/local/nvm
sudo git clone https://github.com/nvm-sh/nvm.git "$NVM_DIR"
sudo bash -c '. "'"$NVM_DIR"'/nvm.sh" && nvm install --lts && nvm alias default node'
```

> **Pitfall (don't do this):** a `/usr/local/bin/node` symlink pointing into a user's home — e.g. `→ /home/<user>/.nvm/.../bin/node` — is **unusable by the jailed service** (ProtectHome masks `/home`) and ties the whole machine to one person's personal nvm. The service resolves node itself via `NVM_DIR`, so it doesn't need such a symlink. If you want a stable `/usr/local/bin/node` for humans, point it at the *system* nvm (`/usr/local/nvm/versions/node/<ver>/bin/node`), never a home dir.

## 1. Mint the two CLDMV fine-grained PATs

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token, **twice**. Resource owner: **CLDMV**. Repository access: **All repositories** (covers slothlet, scopra, …).

**`cldmv-read`** — Repository permissions:

| Permission | Access |
|---|---|
| Issues | Read-only |
| Pull requests | Read-only |
| Contents | Read-only |
| Metadata | Read-only (auto) |

**`cldmv-write`** — Repository permissions:

| Permission | Access |
|---|---|
| Issues | Read and write |
| Pull requests | Read and write |
| Contents | Read and write |
| Metadata | Read-only (auto) |

No organization or admin permissions. If the org requires approval for fine-grained PATs, approve them in Org → Settings → Personal access tokens.

## 2. Provision (root)

```sh
sudo ./deploy/provision.sh repo   # arg = the user your agent runs as
```

It creates the `gh-broker` service user, `gh-broker-clients` group (adds `repo`), `/etc/gh-broker/{config.json,creds}`, encrypts both PATs with `systemd-creds` (paste each when prompted — input hidden, never hits disk/plaintext/history), and installs + enables the unit. It does **not** start the service yet.

## 3. Build + deploy (one command)

```sh
npm ci && npm run build          # as your dev user
sudo ./deploy/deploy-app.sh      # root: unit + config + launcher + dist, then restart
systemctl status gh-broker --no-pager
```

`deploy/deploy-app.sh` is the **single** deploy path — first deploy and every redeploy. It syncs the systemd unit, the config (from the committed `config.example.json`, the source of truth for the allowlist), the node launcher, and the built `dist/` to `/opt/gh-broker`, then restarts and tails the log. (The GitHub-App section below re-runs this same script — there is no separate manual copy step.)

## 4. Point Claude at the broker

The agent connects over the Unix socket via a stdio bridge (bytes only; no token crosses). In `~/.claude.json` `mcpServers`:

```json
"github": {
	"type": "stdio",
	"command": "socat",
	"args": ["STDIO", "UNIX-CONNECT:/run/gh-broker/gh-broker.sock"]
}
```

(`socat` is in the prerequisites above. A re-login is needed after provisioning so `repo`'s `gh-broker-clients` membership is active.) Then reload Claude and retire the old single-org `github-readonly` server.

## Adding an org later

Mint `<org>-read` / `<org>-write` PATs, `systemd-creds encrypt` them into `/etc/gh-broker/creds/`, add an `owners` entry to `config.example.json` (redeploy syncs it), `LoadCredentialEncrypted` lines to the unit, and `sudo ./deploy/deploy-app.sh`. No code or agent changes.

## Enabling `link_issue` (GitHub App)

`link_issue` creates an explicit PR→issue closing reference via `addClosingIssueReference` — a mutation **not available to fine-grained PATs** (only App/classic tokens; verified). It runs on a **GitHub App** installation token, minted internally by Octokit's `@octokit/auth-app` (no hand-rolled token machinery). Reuse the **CLDMV Bot App** your workflows already use. Until configured, `link_issue` returns a clear "needs a GitHub App" error; everything else works.

1. **Gather three values:**
   - **App ID** — App settings → General (a number).
   - **Installation ID** — the App's installation on CLDMV (Org → Settings → GitHub Apps → the install; the number in the URL), or `GET /orgs/CLDMV/installation` with an App JWT.
   - **Private key** — the App `.pem` (you already have it as `CLDMV_BOT_APP_PRIVATE_KEY`).

2. **Encrypt the key** (root; paste the PEM then Ctrl-D — never hits disk in plaintext):
   ```sh
   sudo systemd-creds encrypt --name=gh-app-key - /etc/gh-broker/creds/gh-app-key.cred
   sudo chmod 0400 /etc/gh-broker/creds/gh-app-key.cred
   ```

3. **Load it via a unit drop-in** (leaves the main unit unchanged):
   ```sh
   sudo install -d /etc/systemd/system/gh-broker.service.d
   printf '[Service]\nLoadCredentialEncrypted=gh-app-key:/etc/gh-broker/creds/gh-app-key.cred\n' \
     | sudo tee /etc/systemd/system/gh-broker.service.d/app.conf
   ```

4. **Add the App to `config.example.json`** (committed) + set the owner's installation id:
   ```jsonc
   "app": { "appId": <APP_ID>, "privateKey": "cred:gh-app-key" },
   "owners": { "cldmv": { "read": "cred:cldmv-read", "write": "cred:cldmv-write", "installationId": <INSTALLATION_ID> } }
   ```

5. **Redeploy:** `sudo ./deploy/deploy-app.sh` — the startup log should read `"app":"enabled"`.

## Verify no secret leaks

- The agent user (`repo`) cannot read `/etc/gh-broker/creds/*` (root-owned, 0400) nor the running service's env.
- The socket carries MCP frames only.
- `journalctl -u gh-broker` shows the audit log (tool, owner, mode, repo, result) — never tokens.
