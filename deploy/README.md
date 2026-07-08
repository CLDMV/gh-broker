# Deploying gh-broker

Phase 0 (provisioning) runs as **root** and is the only privileged step. Everything else runs as the unprivileged dev user.

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

## 3. Build + deploy the app (dev user, then a root copy)

```sh
npm ci && npm run build
sudo rsync -a --delete dist/ /opt/gh-broker/dist/
sudo chown -R gh-broker:gh-broker /opt/gh-broker
sudo systemctl start gh-broker
systemctl status gh-broker --no-pager
```

The unit runs the system-wide nvm node at `/usr/local/nvm/versions/node/v26.4.0/bin/node` (v18 at `/usr/bin/node` is too old, and `ProtectHome` blocks any `/home` nvm). If you bump node, update the `ExecStart` line.

## 4. Point Claude at the broker

The agent connects over the Unix socket via a stdio bridge (bytes only; no token crosses). In `~/.claude.json` `mcpServers`:

```json
"github": {
	"type": "stdio",
	"command": "socat",
	"args": ["STDIO", "UNIX-CONNECT:/run/gh-broker/gh-broker.sock"]
}
```

(Install `socat` if absent. A re-login is needed after provisioning so `repo`'s `gh-broker-clients` membership is active.) Then reload Claude and retire the old single-org `github-readonly` server.

## Adding an org later

Mint `<org>-read` / `<org>-write` PATs, `systemd-creds encrypt` them into `/etc/gh-broker/creds/`, add an `owners` entry to `/etc/gh-broker/config.json`, `LoadCredentialEncrypted` lines to the unit, and `systemctl restart gh-broker`. No code or agent changes.

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
