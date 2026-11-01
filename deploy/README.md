# Deploying gh-broker

One interactive installer does first-install and upgrade. Design and rationale: [`../docs/deploy-architecture.md`](../docs/deploy-architecture.md). The broker runs as a dedicated `gh-broker` service user, separate from the unprivileged user the agent runs as — that two-user split is the security boundary; see [`../docs/agent-user-model.md`](../docs/agent-user-model.md).

## 0. Host prerequisites

- **Node ≥ 20** — the only real prerequisite; the installer runs under it (`sudo node deploy/install.mjs`). If node isn't installed yet, the optional Linux bootstrap `sudo ./deploy/install.sh` sets up a system-wide nvm + node + the `/usr/local/bin/node` symlink, then hands off to the Node installer.
- **`socat`** — the agent's stdio↔socket bridge. **`rsync`** — used to sync the build (falls back to a plain copy if absent). **`systemd`** with `systemctl`. **`sudo`** — used internally to build as the checkout's own owner (see step 5 below), not just to invoke the installer itself. Install what's missing (`apt install socat rsync sudo` etc.).

The installer maintains `/usr/local/bin/node` as the single node indirection (CLI and service resolve the same link). Bumping node is re-pointing that symlink — which the installer does on every run.

## 1. Mint the two fine-grained PATs

For each GitHub owner (user or org) the broker serves, `<org>`: GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token, **twice**. Resource owner: `<org>`. Repository access: **All repositories**.

**`<org>-read`** — Issues: Read, Pull requests: Read, Contents: Read, Metadata: Read (auto).
**`<org>-write`** — Issues: R/W, Pull requests: R/W, Contents: R/W, Metadata: Read (auto).

No organization or admin permissions. If the org requires approval for fine-grained PATs, approve them in Org → Settings → Personal access tokens. The two-PAT split (read vs write) is a deliberate least-privilege control — see the design doc.

### GHCR pushes: one classic PAT (`<org>-packages`)

`ghcr_push` needs a third credential, because the GitHub Container Registry does not accept fine-grained PATs. Create a **classic** token with **`write:packages` only** (it implies `read:packages`; do not add `delete:packages`, and add `repo` only if pushes to a private-repo-linked package are refused without it), and set an expiry: [create the token](https://github.com/settings/tokens/new?scopes=write:packages&description=gh-broker%20ghcr). Enable it with `--ghcr-owner <org> --ghcr-username <login> --ghcr-image <name>` (or a `ghcr` block in a `--config` file, see [Configuring the install](#configuring-the-install)). The installer then prompts for the token as `<org>-packages`; it is an **optional credential**, so you can press Enter to skip it (an unattended run skips it with a note), and the broker then starts normally with the `ghcr_*` tools hidden until the token is stored. Supply it on a later run with `--secret <org>-packages=<token>`, `--secrets-file` or env `GH_BROKER_SECRET_<ORG>_PACKAGES`. `--ghcr-username` (`ghcr.owners.<org>.username`) must be the GitHub login that owns the token.

The installer also creates the drop directory from `ghcr.dropDir` (default `/srv/gh-broker/ghcr-drop`) as `2750 <agent-user>:gh-broker`: the agent writes archives there, the setgid bit gives each file the broker's group, and nobody else can look in. Archives must be group-readable (`chmod g+r`); the broker can only read them, so the agent deletes them after a push. See [`../docs/TOOLS.md`](../docs/TOOLS.md#ghcr_push).

## 2. Install (first install AND upgrade — same command)

```sh
sudo node deploy/install.mjs [agent-user]
```

`agent-user` defaults to `$SUDO_USER` (the account you ran `sudo` from). The installer walks the whole thing and is idempotent:

1. checks prerequisites,
2. **creates or confirms the agent user** (stops if it can't — no silent half-install),
3. creates the `gh-broker` service user + `gh-broker-clients` bridge group, adds the agent user to it (and, when the config has a `ghcr` block, creates the GHCR drop directory),
4. points `/usr/local/bin/node` at the running node,
5. builds `dist/` if it isn't already built, or rebuilds it if a prior run left it (or `node_modules/`) owned by someone other than the checkout's owner — the build itself runs via `sudo -u '#<uid>'` as whoever owns `deploy/install.mjs`, not as root, so the installer never leaves root-owned files behind in your checkout,
6. regenerates the config by layering `config.example.json`, whatever is deployed, your `--config` file and your flags (your data is preserved; allowlist changes from the repo arrive; see [Configuring the install](#configuring-the-install)); a first install with no owner asks for one,
7. sets up the optional **npm integration** when asked (offered on a first install, or `--npm`): an npm web login it waits on, then the token it creates for `npm_scaffold` (see [npm integration](#npm-integration-npm_scaffold)),
8. **asks how to store the credentials** — `systemd-creds` (encrypted at rest, host-bound; recommended) or a plaintext `file` (`0640 root:gh-broker`; portable) — then stores the tokens in the chosen backend: it keeps existing creds, decrypts a legacy `systemd-creds` token when you switch to `file`, and **prompts only for what it can't find** (input hidden),
9. validates the config with the real loader (`--check`),
10. installs the unit, deploys `dist/`, restarts, and
11. runs a **smoke test** (MCP handshake + a real read over the socket) → ✅/❌.

### Unattended (single non-interactive command)

Pass flags plus `--non-interactive` (`-y`) to skip every prompt: `--agent-user <name>`, `--secrets-provider systemd-creds|file`, `--create-agent-user`, and supply tokens via `--secrets-file <json>` (`{ "<cred-name>": "<token>" }`), env `GH_BROKER_SECRET_<NAME>` (NAME upper-cased, non-alnum → `_`), or `--secret <cred-name>=<token>` (repeatable; a name the config doesn't use is refused, so a typo can't silently do nothing; it is visible in the process list and shell history, so prefer the file or env). Precedence is `--secret`, then the file, then env, then the interactive prompt; a token from any of the first three replaces a stored one. Example:

```sh
sudo GH_BROKER_SECRET_ACME_READ=… GH_BROKER_SECRET_ACME_WRITE=… \
  /usr/local/bin/node deploy/install.mjs --agent-user repo --owner acme \
  --secrets-provider systemd-creds --non-interactive
```

Re-running on an existing install needs no `--owner`: the deployed owners are kept. Migrating an existing `systemd-creds` install needs **no tokens** — `--secrets-provider systemd-creds --non-interactive` keeps the existing `.cred` files (nothing to prompt). `--help` lists every flag.

**Upgrade** is just re-running it: config merged (edits kept), your previously-chosen storage backend pre-selected, existing tokens kept. You can **switch backends** on any run — pick `file` and it decrypts the existing `systemd-creds` tokens into the file (no re-entry); pick `systemd-creds` and it encrypts the tokens into `.cred` files. `launch.sh` is no longer used — remove it after a successful run: `sudo rm -f /opt/gh-broker/launch.sh` (and `sudo rm -rf /etc/gh-broker/creds` only if you've moved fully to the `file` backend).

## Credential storage — your choice

The installer asks which backend holds the tokens at rest:

- **`systemd-creds`** (recommended, Linux): tokens are encrypted with a host/TPM-bound key (`.cred` files delivered via a unit drop-in into memory-only `$CREDENTIALS_DIRECTORY`). Encrypted at rest and resistant to backup/disk theft; not portable to another machine.
- **`file`**: tokens in a plaintext JSON file, `0640 root:gh-broker`. Portable and platform-neutral; at-rest protection is filesystem permissions only.

Either way the **agent user cannot read the tokens** (that's filesystem perms, not encryption) and the **config stays token-free**. The choice only affects at-rest protection vs portability. See [`../docs/deploy-architecture.md`](../docs/deploy-architecture.md).

## Configuring the install

`config.example.json` ships only the generic defaults: `listen`, `upstream` and the `tools` allowlist. Everything specific to your deployment (owners, GHCR, App, npm, secrets) is supplied at install time. `config.sample.json` shows a complete config with placeholder values; nothing loads it.

Settings are layered, lowest precedence first:

1. `config.example.json` (shipped defaults),
2. the config already deployed on the host,
3. `--config <file>`,
4. command-line flags.

A scalar is replaced by a higher layer. `owners` and `ghcr.owners` are merged per owner, so adding an owner never drops the deployed ones. `tools` always comes from the example: the allowlist is a security control, so a `--config` file that contains `tools` is refused. The `--config` file is JSON in the deployed config's shape, holds only `cred:` references (a value shaped like a token is refused), and the merged result is validated by the real loader before anything is deployed. An upgrade run with no config flags keeps the deployed owners, `ghcr` and everything else as they are.

| Flag | Sets |
|---|---|
| `--config <file>` | JSON config file merged on top of the deployed config |
| `--owner <org>` (repeatable) | `owners.<org>` = `cred:<org>-read` / `cred:<org>-write` |
| `--installation-id <org>=<id>` (repeatable) | `owners.<org>.installationId` |
| `--default-owner <org>` | `defaultOwner` (a first install with a single owner defaults to it) |
| `--listen <unix:path>` | `listen` |
| `--upstream <url>` | `upstream` |
| `--app-id <n>`, `--app-private-key <cred-name>` | `app.appId`, `app.privateKey` (`cred:gh-app-key` unless named) |
| `--secrets-provider <p>`, `--secrets-path <path>` | `secrets.provider`, `secrets.path` (path is for the `file` provider) |
| `--npm`, `--npm-scope`, `--npm-org`, `--npm-registry <url>`, `--npm-token-days` | the `npm` block, see [npm integration](#npm-integration-npm_scaffold) |
| `--ghcr-owner <org>`, `--ghcr-username <login>`, `--ghcr-image <glob>` (repeatable) | `ghcr.owners.<org>`; the credential is `cred:<org>-packages` |
| `--ghcr-drop-dir <path>` | `ghcr.dropDir` (default `/srv/gh-broker/ghcr-drop`) |
| `--ghcr-max-archive-bytes <n>` | `ghcr.maxArchiveBytes` |
| `--protect-release-tags`, `--no-protect-release-tags` | `ghcr.protectReleaseTags` |

Flags that build a single GHCR owner do so for one owner per run; use `--config` for several, or for a credential name other than the derived one.

With no owner anywhere (a first install with no flags and no `--config`), an interactive run asks for the GitHub owner name and then for its two tokens; `--non-interactive` fails and names `--owner` / `--config`.

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

Re-run the installer with `--owner <org>` (repeatable). The deployed owners stay, the new one is added with `cred:<org>-read` / `cred:<org>-write`, and the installer prompts for its two tokens. No code change.

## npm integration (`npm_scaffold`)

Optional. It lets `npm_scaffold` create new npm packages and their trusted publishers. The broker holds an npm granular access token; the installer creates it for you.

**Enable or rotate:** re-run the installer with `--npm` (a first interactive install also offers it). The installer then:

1. asks which scopes to allow (`--npm-scope @your-org`, repeatable; defaults to the existing setting, else `@<first owner>`),
   and, with `--npm-org your-org` (repeatable), also grants the token org read-write on those orgs; the choice is saved as `npm.tokenOrgs` so a later rotation creates the same kind of token,
2. starts an npm web login and shows the login link, then **waits** until you approve it in a browser (the same flow as `npm login --auth-type=web`),
3. asks for your npm password and a one-time password (both hidden; the password is used for this one request and never stored), and creates a granular token: those scopes read-write, `--npm-token-days` lifetime (default 90), **no 2FA bypass**,
4. revokes the login session, stores the token as `npm-token` in the chosen credential backend, and adds `"npm": { "token": "cred:npm-token", "scopes": [...] }` to the config.

Without 2FA bypass the token can't publish or change trust settings on its own: every npm write `npm_scaffold` makes carries its own one-time password from you (one for the publish, one for the trusted publisher). Running `--npm` again creates a fresh token and replaces the stored one. The installer does not revoke the old token; it says so, and the old one stays valid until it expires or you revoke it in your npm account's Access Tokens settings.

**Unattended:** the web login needs a browser, so `--non-interactive --npm` takes an existing token instead, via `--secrets-file` (`{ "npm-token": "npm_…" }`) or env `GH_BROKER_SECRET_NPM_TOKEN`.

Without the `npm` block nothing changes: the installer says "not enabled", and the broker does not expose `npm_scaffold` at all (startup logs why). The token is an **optional credential**: if it is missing (skipped at the prompt, or an unattended run without it), the installer carries on and the broker starts normally with `npm_scaffold` hidden. Only the owners' PATs are required.

## Enabling `link_issue` (GitHub App) — DEFERRED

> **Status: deferred / not wired in.** `link_issue` is implemented in `src/verbs/link_issue.ts` but its catalog (advertise) and router (dispatch) hooks are **commented out**, and it has no entry in `config.example.json`'s allowlist — so it is neither advertised nor callable. To turn it on: uncomment the `link_issue` blocks in `src/catalog.ts` and `src/router.ts` (and their imports), add `{ "name": "link_issue", "mode": "write", "custom": true }` to the tools allowlist, and configure a GitHub App.

`link_issue` creates an explicit PR→issue closing reference via `addClosingIssueReference` — a mutation **not available to fine-grained PATs** (only App/classic tokens). It runs on a **GitHub App** installation token (`@octokit/auth-app`, from `config.app` = `{ appId, privateKey: "cred:gh-app-key" }` plus the owner's `installationId`). Store the App key like any other credential — as `gh-app-key` in the secrets file.

## Verify no secret leaks

- The agent user cannot read `/etc/gh-broker/` — the dir is `0750 root:gh-broker`; the config (`0640`) and, whichever backend is used, the tokens (systemd-creds `.cred` files `0400 root`, or the `file` backend's `secrets.json` `0640 root:gh-broker`) are unreadable to a non-member.
- The config file holds **no tokens** — only `cred:` references; the tokens live in the separate secret store.
- The socket carries MCP frames only.
- `journalctl -u gh-broker` shows the audit log (tool, owner, mode, repo, result) — never tokens.
