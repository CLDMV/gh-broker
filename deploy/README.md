# Deploying gh-broker

One interactive installer does first-install and upgrade. Design and rationale: [`../docs/deploy-architecture.md`](../docs/deploy-architecture.md). The broker runs as a dedicated `gh-broker` service user, separate from the unprivileged user the agent runs as — that two-user split is the security boundary; see [`../docs/agent-user-model.md`](../docs/agent-user-model.md).

## 0. Host prerequisites

- **Node ≥ 20** — the only real prerequisite; the installer runs under it (`sudo node deploy/install.mjs`). If node isn't installed yet, the optional Linux bootstrap `sudo ./deploy/install.sh` sets up a system-wide nvm + node + the `/usr/local/bin/node` symlink, then hands off to the Node installer.
- **`socat`** — the agent's stdio↔socket bridge. **`rsync`** — used to sync the build (falls back to a plain copy if absent). **`systemd`** with `systemctl`. **`sudo`** — used internally to build as the checkout's own owner (see step 5 below), not just to invoke the installer itself. Install what's missing (`apt install socat rsync sudo` etc.).

The installer maintains `/usr/local/bin/node` as the single node indirection (CLI and service resolve the same link). Bumping node is re-pointing that symlink — which the installer does on every run.

## 1. Mint the two CLDMV fine-grained PATs

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token, **twice**. Resource owner: **CLDMV**. Repository access: **All repositories**.

**`cldmv-read`** — Issues: Read, Pull requests: Read, Contents: Read, Metadata: Read (auto).
**`cldmv-write`** — Issues: R/W, Pull requests: R/W, Contents: R/W, Metadata: Read (auto).

No organization or admin permissions. If the org requires approval for fine-grained PATs, approve them in Org → Settings → Personal access tokens. The two-PAT split (read vs write) is a deliberate least-privilege control — see the design doc.

## 2. Install (first install AND upgrade — same command)

```sh
sudo node deploy/install.mjs [agent-user]
```

`agent-user` defaults to `$SUDO_USER` (the account you ran `sudo` from). The installer walks the whole thing and is idempotent:

1. checks prerequisites,
2. **creates or confirms the agent user** (stops if it can't — no silent half-install),
3. creates the `gh-broker` service user + `gh-broker-clients` bridge group, adds the agent user to it,
4. points `/usr/local/bin/node` at the running node,
5. builds `dist/` if it isn't already built, or rebuilds it if a prior run left it (or `node_modules/`) owned by someone other than the checkout's owner — the build itself runs via `sudo -u '#<uid>'` as whoever owns `deploy/install.mjs`, not as root, so the installer never leaves root-owned files behind in your checkout,
6. regenerates the config by **merging** `config.example.json` with whatever is deployed (your data is preserved; new keys/allowlist changes from the repo arrive),
7. sets up the optional **npm integration** when asked (offered on a first install, or `--npm`): an npm web login it waits on, then the token it creates for `npm_scaffold` (see [npm integration](#npm-integration-npm_scaffold)),
8. **asks how to store the credentials** — `systemd-creds` (encrypted at rest, host-bound; recommended) or a plaintext `file` (`0640 root:gh-broker`; portable) — then stores the tokens in the chosen backend: it keeps existing creds, decrypts a legacy `systemd-creds` token when you switch to `file`, and **prompts only for what it can't find** (input hidden),
9. validates the config with the real loader (`--check`),
10. installs the unit, deploys `dist/`, restarts, and
11. runs a **smoke test** (MCP handshake + a real read over the socket) → ✅/❌.

### Unattended (single non-interactive command)

Pass flags plus `--non-interactive` (`-y`) to skip every prompt: `--agent-user <name>`, `--secrets-provider systemd-creds|file`, `--create-agent-user`, and supply tokens via `--secrets-file <json>` (`{ "<cred-name>": "<token>" }`) or env `GH_BROKER_SECRET_<NAME>` (NAME upper-cased, non-alnum → `_`). Example:

```sh
sudo GH_BROKER_SECRET_CLDMV_READ=… GH_BROKER_SECRET_CLDMV_WRITE=… \
  /usr/local/bin/node deploy/install.mjs --agent-user repo \
  --secrets-provider systemd-creds --non-interactive
```

Migrating an existing `systemd-creds` install needs **no tokens** — `--secrets-provider systemd-creds --non-interactive` keeps the existing `.cred` files (nothing to prompt). `--help` lists every flag.

**Upgrade** is just re-running it: config merged (edits kept), your previously-chosen storage backend pre-selected, existing tokens kept. You can **switch backends** on any run — pick `file` and it decrypts the existing `systemd-creds` tokens into the file (no re-entry); pick `systemd-creds` and it encrypts the tokens into `.cred` files. `launch.sh` is no longer used — remove it after a successful run: `sudo rm -f /opt/gh-broker/launch.sh` (and `sudo rm -rf /etc/gh-broker/creds` only if you've moved fully to the `file` backend).

## Credential storage — your choice

The installer asks which backend holds the tokens at rest:

- **`systemd-creds`** (recommended, Linux): tokens are encrypted with a host/TPM-bound key (`.cred` files delivered via a unit drop-in into memory-only `$CREDENTIALS_DIRECTORY`). Encrypted at rest and resistant to backup/disk theft; not portable to another machine.
- **`file`**: tokens in a plaintext JSON file, `0640 root:gh-broker`. Portable and platform-neutral; at-rest protection is filesystem permissions only.

Either way the **agent user cannot read the tokens** (that's filesystem perms, not encryption) and the **config stays token-free**. The choice only affects at-rest protection vs portability. See [`../docs/deploy-architecture.md`](../docs/deploy-architecture.md).

## 3. Point Claude at the broker

The installer prints this; add it to the agent user's `~/.claude.json` `mcpServers`:

```json
"github": {
	"type": "stdio",
	"command": "socat",
	"args": ["STDIO", "UNIX-CONNECT:/run/gh-broker/gh-broker.sock"]
}
```

Re-login as the agent user first, so its `gh-broker-clients` membership is active.

## Adding an org later

Add an `owners` entry to `config.example.json` (name + `cred:<org>-read` / `cred:<org>-write` refs), then re-run the installer — the merge brings the new owner through, and it prompts for the new credentials. No code change.

## npm integration (`npm_scaffold`)

Optional. It lets `npm_scaffold` create new npm packages and their trusted publishers. The broker holds an npm granular access token; the installer creates it for you.

**Enable or rotate:** re-run the installer with `--npm` (a first interactive install also offers it). The installer then:

1. asks which scopes to allow (`--npm-scope @cldmv`, repeatable; defaults to the existing setting, else `@<first owner>`),
   and, with `--npm-org cldmv` (repeatable), also grants the token org read-write on those orgs; the choice is saved as `npm.tokenOrgs` so a later rotation creates the same kind of token,
2. starts an npm web login and shows the login link, then **waits** until you approve it in a browser (the same flow as `npm login --auth-type=web`),
3. asks for your npm password (hidden, used for this one request and never stored) and a one-time password, and creates a granular token: those scopes read-write, `--npm-token-days` lifetime (default 90), **no 2FA bypass**,
4. revokes the login session, stores the token as `npm-token` in the chosen credential backend, and adds `"npm": { "token": "cred:npm-token", "scopes": [...] }` to the config.

Without 2FA bypass the token can't publish or change trust settings on its own: every npm write `npm_scaffold` makes carries its own one-time password from you (one for the publish, one for the trusted publisher). Running `--npm` again creates a fresh token and replaces the stored one (the old token stays valid until it expires or you revoke it at `https://www.npmjs.com/settings/<user>/tokens`).

**Unattended:** the web login needs a browser, so `--non-interactive --npm` takes an existing token instead, via `--secrets-file` (`{ "npm-token": "npm_…" }`) or env `GH_BROKER_SECRET_NPM_TOKEN`.

Without the `npm` block nothing changes: the installer says "not enabled" and the verb refuses with a pointer to `--npm`.

## Enabling `link_issue` (GitHub App) — DEFERRED

> **Status: deferred / not wired in.** `link_issue` is implemented in `src/verbs/link_issue.ts` but its catalog (advertise) and router (dispatch) hooks are **commented out**, and it has no entry in `config.example.json`'s allowlist — so it is neither advertised nor callable. To turn it on: uncomment the `link_issue` blocks in `src/catalog.ts` and `src/router.ts` (and their imports), add `{ "name": "link_issue", "mode": "write", "custom": true }` to the tools allowlist, and configure a GitHub App.

`link_issue` creates an explicit PR→issue closing reference via `addClosingIssueReference` — a mutation **not available to fine-grained PATs** (only App/classic tokens). It runs on a **GitHub App** installation token (`@octokit/auth-app`, from `config.app` = `{ appId, privateKey: "cred:gh-app-key" }` plus the owner's `installationId`). Store the App key like any other credential — as `gh-app-key` in the secrets file.

## Verify no secret leaks

- The agent user cannot read `/etc/gh-broker/` — the dir is `0750 root:gh-broker`; the config (`0640`) and, whichever backend is used, the tokens (systemd-creds `.cred` files `0400 root`, or the `file` backend's `secrets.json` `0640 root:gh-broker`) are unreadable to a non-member.
- The config file holds **no tokens** — only `cred:` references; the tokens live in the separate secret store.
- The socket carries MCP frames only.
- `journalctl -u gh-broker` shows the audit log (tool, owner, mode, repo, result) — never tokens.
