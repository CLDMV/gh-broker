# Deploying gh-broker

One interactive installer does first-install and upgrade. Design and rationale: [`../docs/deploy-architecture.md`](../docs/deploy-architecture.md). The broker runs as a dedicated `gh-broker` service user, separate from the unprivileged user the agent runs as — that two-user split is the security boundary; see [`../docs/agent-user-model.md`](../docs/agent-user-model.md).

## 0. Host prerequisites

- **Node ≥ 20** — the only real prerequisite; the installer runs under it (`sudo node deploy/install.mjs`). If node isn't installed yet, the optional Linux bootstrap `sudo ./deploy/install.sh` sets up a system-wide nvm + node + the `/usr/local/bin/node` symlink, then hands off to the Node installer.
- **`socat`** — the agent's stdio↔socket bridge. **`rsync`** — used to sync the build (falls back to a plain copy if absent). **`systemd`** with `systemctl`. Install what's missing (`apt install socat rsync` etc.).

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
5. builds `dist/` if it isn't already built,
6. regenerates the config by **merging** `config.example.json` with whatever is deployed (your data is preserved; new keys/allowlist changes from the repo arrive),
7. **prompts for any PATs not already stored** (input hidden) and writes the secrets file `0640 root:gh-broker`,
8. validates the config with the real loader (`--check`),
9. installs the unit, deploys `dist/`, restarts, and
10. runs a **smoke test** (MCP handshake + a real read over the socket) → ✅/❌.

**Upgrade** is just re-running it: the config is merged (edits kept), and secrets already present are kept — only missing ones are prompted for.

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

## Enabling `link_issue` (GitHub App) — DEFERRED

> **Status: deferred / not wired in.** `link_issue` is implemented in `src/verbs/link_issue.ts` but its catalog (advertise) and router (dispatch) hooks are **commented out**, and it has no entry in `config.example.json`'s allowlist — so it is neither advertised nor callable. To turn it on: uncomment the `link_issue` blocks in `src/catalog.ts` and `src/router.ts` (and their imports), add `{ "name": "link_issue", "mode": "write", "custom": true }` to the tools allowlist, and configure a GitHub App.

`link_issue` creates an explicit PR→issue closing reference via `addClosingIssueReference` — a mutation **not available to fine-grained PATs** (only App/classic tokens). It runs on a **GitHub App** installation token (`@octokit/auth-app`, from `config.app` = `{ appId, privateKey: "cred:gh-app-key" }` plus the owner's `installationId`). Store the App key like any other credential — as `gh-app-key` in the secrets file.

## Verify no secret leaks

- The agent user cannot read `/etc/gh-broker/` — the dir is `0750 root:gh-broker`; the config (`0640`) and secrets file (`0640 root:gh-broker`) are unreadable to a non-member.
- The config file holds **no tokens** — only `cred:` references; the tokens live in the separate secrets file.
- The socket carries MCP frames only.
- `journalctl -u gh-broker` shows the audit log (tool, owner, mode, repo, result) — never tokens.
