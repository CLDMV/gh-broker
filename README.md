# @cldmv/gh-broker

A local **credential-routing MCP proxy** for GitHub. It lets an autonomous agent read and write GitHub issues/PRs across multiple orgs **without ever possessing a token** — the agent gets to *act*, never to *hold* the credential.

## Why

The hosted GitHub MCP authenticates with one token per server, so multi-org means many servers (tool-list bloat) and the token sits in an agent-readable config file. A classic PAT spans orgs but is coarse; a GitHub App gives bot attribution and can't drive the MCP. `gh` and raw PATs are readable by the agent (`gh auth token`, `cat ~/.claude.json`). None satisfy: **user identity + least-privilege + multi-org + one server + the agent cannot exfiltrate the secret.**

## How

A small daemon (this package) runs as a dedicated **`gh-broker` system user** and:

- holds per-org **read-scoped** and **write-scoped** fine-grained PATs, read from an agent-unreadable secret store — `systemd-creds` (encrypted at rest, default) or a plaintext file, chosen at install — via `cred:` references in a token-free config, into memory only;
- routes the right PAT by **repo owner + read/write mode** on each call;
- exposes a **config-driven, default-deny** toolset — mostly **proxied** to GitHub's hosted MCP (which already does labels, type, issue fields, dedup), plus **custom verbs** for gaps the hosted MCP has no tool for, and **augmented** tools that extend a proxied tool's response in place. See [Key Features](#-key-features) and [docs/TOOLS.md](docs/TOOLS.md) for the full set;
- talks to the agent over a **Unix socket** (bytes only; no token crosses).

The agent (uid 1003, rootless docker, no passwordless sudo — verified) cannot read another user's mode-0400 secrets, so the boundary is real. The **agent-as-separate-user** model — the users, the bridge group, and the permissions that make the boundary real, as a reproducible example setup — is documented in [`docs/agent-user-model.md`](docs/agent-user-model.md).

Full design + threat model: `~/.claude/designs/github-mcp-broker.md`.

---

## 🚀 Key Features

### 🔒 **Use ≠ Possession**

The agent can trigger a GitHub read/write; it can never hold the token that performs it. A separate system user owns the secret store and the daemon; the agent reaches it only over a permissioned Unix socket carrying MCP frames, never credential material.

🔒 **For the full isolation model — users, groups, filesystem permissions, verified against this host — see [docs/agent-user-model.md](docs/agent-user-model.md)**

### 🎯 **Default-Deny, Config-Driven Toolset**

A tool not listed in `config.tools` is neither advertised nor executable. Adding an org is a config entry plus two credentials — no new server, no new agent-visible tool-list bloat. Each entry is `mode: "read"` or `"write"`, optionally `custom` (handled entirely locally) or `augment` (proxied, then enriched) — see below.

### 📊 **CI Visibility Without Per-Call Log Fetches**

`report_ci_status` answers "does this PR have failing checks" at whatever detail level you ask for — counts only by default, escalating to which job failed, which step failed, and a tail of the failing job's actual log — paying for that detail only on runs that are genuinely failing. The same status can ride inline on a normal `pull_request_read` via an opt-in `ciVerbosity` parameter.

```json
{ "owner": "cldmv", "repo": "droidsock", "pull": 35, "verbosity": 2 }
```

📊 **For every tier, the classification rules, and real verified examples, see [docs/TOOLS.md](docs/TOOLS.md#report_ci_status)**

### 🏷️ **Cross-Repo Label Auditing**

`report_unlabeled` finds every issue/PR with no labels — in one repo, or every repo an owner has — bounded by fan-out safety caps and a rate-limit floor that reads the token's own real limit rather than assuming one.

🏷️ **Full parameter reference: [docs/TOOLS.md](docs/TOOLS.md#report_unlabeled)**

### 🔧 **Extensible By Design**

The broker presents its **own** MCP contract to the agent — a proxied tool's schema and response are not required to match the hosted MCP's exactly. Adding a custom verb or extending a proxied tool with new parameters follows a documented pattern, not a one-off hack.

🔧 **How to add one: [docs/TOOLS.md § Extending this](docs/TOOLS.md#extending-this-adding-a-new-custom-verb-or-augmented-tool)**

### 📦 **One-Command Install & Upgrade**

`sudo node deploy/install.mjs` handles first install and every upgrade: builds under the checkout's own owner (no `chown`, ever), merges shipped config defaults over the deployed config, lets you choose how PATs are stored at rest, and runs a post-deploy smoke test.

📦 **Full prerequisites, PAT scopes, and flags: [deploy/README.md](deploy/README.md)**

---

## ✨ What's New

### Latest: v0.4.0 (September 2026)

- **CI visibility without per-call log fetches** — `report_ci_status` reports pass/fail/pending counts for a PR (or every open PR in a repo) by default, escalating on request to which job failed, which step failed, and a tail of the failing job's log — paying for that detail only on runs that are genuinely failing. `pull_request_read` can now carry the same status inline via an opt-in `ciVerbosity` parameter, the first tool built on the router's new **augment** dispatch mode (forward to the hosted MCP, then enrich the result in place).
- **`report_unlabeled`** — issues/PRs with no labels, for one repo or every repo an owner has, with a rate-limit floor scaled to the token's own real limit rather than a hardcoded guess.
- Fixed `npm run dev` crashing outright (a TypeScript syntax `node --experimental-strip-types` can't handle) and an installer bug that left build output root-owned in the operator's own checkout.
- [View full v0.4.0 Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.4.0.md)

### Recent Releases

- **v0.3.2** (September 2026) — Bump the CI test matrix + Dependabot grouping to match the v0.3.1 Node floor raise ([Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.3.2.md))
- **v0.3.1** (September 2026) — Raise the Node floor to `>=22.12.0` for `vitest` 5 compatibility ([Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.3.1.md))
- **v0.3.0** (September 2026) — Portable Node installer: `deploy/install.mjs` replaces the old shell scripts with config merging, a choice of credential-storage backend, and a post-deploy smoke test ([Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.3.0.md))
- **v0.2.5** (September 2026) — Security hotfix: bump the `npm_and_yarn` group across 1 directory (4 updates; [#40](https://github.com/CLDMV/gh-broker/pull/40)) ([Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.2.5.md))

📚 For the complete version history, see the [docs/changelog/](https://github.com/CLDMV/gh-broker/tree/master/docs/changelog/) folder.

---

## Calling a tool

The agent's MCP client sees an ordinary `tools/call`; the broker resolves the credential, routes it, and (for custom/augmented tools) does the extra work in between:

```json
// tools/call
{ "name": "report_ci_status", "arguments": { "owner": "cldmv", "repo": "droidsock", "pull": 35, "verbosity": 1 } }
```

```json
// result
{ "pull": 35, "summary": { "passed": 6, "failed": 1, "pending": 0 }, "failures": [{ "workflow": "🧪 CI Tests & Build", "job": "Build & Test (22.12)", "runId": 34787050719, "runUrl": "https://github.com/CLDMV/droidsock/actions/runs/34787050719", "conclusion": "failure" }] }
```

No token ever appears in the request, the response, or anywhere the agent can read. See [docs/TOOLS.md](docs/TOOLS.md) for every custom and augmented tool, with full parameter tables and real verified examples.

---

## Layout

```
src/
  index.ts          entry — resolve paths, load config + secrets, start server
  paths.ts          platform-neutral config/secrets path resolution
  config.ts         load + validate the token-free config
  secrets.ts        resolve cred refs from the secrets file (provider seam)
  router.ts         allowlist (default-deny) + owner/mode → PAT + dispatch (custom/augment/forward)
  upstream.ts       pool of MCP clients to the hosted GitHub MCP (per-token, Bearer)
  catalog.ts        build the advertised tool list (real upstream schemas + custom + augmented)
  server.ts         Unix-socket MCP server toward the agent (StdioServerTransport)
  audit.ts          structured audit log (never tokens)
  verbs/
    report_unlabeled.ts  issues/PRs with no labels, one repo or org-wide
    report_ci_status.ts  tiered CI status for a PR or every open PR in a repo
    rest-client.ts       shared rate-limit-floor + call-budget REST helpers
    review_thread.ts     resolve/reply PR review threads (write PAT)
    link_issue.ts         addClosingIssueReference (App token) — DEFERRED, not wired in
deploy/
  install.mjs       interactive installer — first install AND upgrade (sudo node)
  install.sh        optional Linux bootstrap — set up node, then hand off to install.mjs
  lib/              installer pieces (config merge, secret store, system ops, smoke test)
  gh-broker.service systemd unit (hardened)
  README.md         prerequisites + PAT scopes + install/upgrade/wiring
docs/
  TOOLS.md                reference for every custom/augmented tool, with real examples
  deploy-architecture.md  config merge, secret store, node handling, installer flow
  agent-user-model.md     the agent-as-separate-user isolation model (example setup)
  changelog/              per-version release notes
config.example.json  shipped defaults (token-free); merged into the deployed config
```

## 📚 Documentation

- **[Tools Reference](docs/TOOLS.md)** — every custom and augmented tool: `report_unlabeled`, `report_ci_status`, the `pull_request_read` `ciVerbosity` extension, `resolve_review_thread`/`reply_review_thread`, and how to add a new one
- **[Agent-as-Separate-User Model](docs/agent-user-model.md)** — the isolation model behind "use ≠ possession": users, groups, filesystem permissions, verified against a real host
- **[Deploy Architecture](docs/deploy-architecture.md)** — config merge, secret store backends, node handling, the installer's full flow
- **[Install Guide](deploy/README.md)** — prerequisites, PAT scopes, install/upgrade command, flags
- **[Changelog](docs/changelog/)** — per-version release notes

## Status

**Deployed and in production** — running under systemd, brokering live GitHub reads and writes across the configured org. The Unix-socket MCP server, the default-deny allowlist, owner/mode→PAT routing, and every custom/augmented tool in [docs/TOOLS.md](docs/TOOLS.md) are exercised in normal use — `report_ci_status` and the `pull_request_read` augmentation have both been verified against real failing CI data, not just mocked tests. `link_issue` (App-token-only) is implemented but deferred — see [`deploy/README.md`](deploy/README.md#enabling-link_issue-github-app--deferred). Install/upgrade with `sudo node deploy/install.mjs` (see [`deploy/README.md`](deploy/README.md)).

## Install / build

```sh
npm ci
npm run typecheck
npm run build
```

## License

Apache-2.0 © Shinrai / CLDMV

Private (not published) — it's an internal security daemon.
