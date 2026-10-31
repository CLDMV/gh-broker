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

### 🏷️ **Label Edits That Leave Other Labels Alone**

The hosted MCP's `issue_write` takes `labels` as a full replacement, so changing one status label that way drops every other label on the issue. `issue_labels` edits labels one at a time instead: `add` and `remove` (one or several, combinable), `swap` (drop every `status: ` label and add `status: verified` in one call), and an explicit `set`. A misspelled label is refused rather than created, and the call returns the resulting set.

```json
{ "owner": "cldmv", "repo": "gh-broker", "issue_number": 117, "swap": { "prefix": "status: ", "to": "status: implemented" } }
```

🏷️ **Full parameter reference: [docs/TOOLS.md](docs/TOOLS.md#issue_labels)**

### 📦 **New npm Packages Without a Manual First Publish**

npm only accepts a trusted publisher on a package that already exists, so every new package used to need a hand-run first publish and a form on npmjs.com. `npm_scaffold` does both: it publishes a broker-built placeholder (`0.0.0-stage`, no code) and registers the repo's publish workflow as the trusted publisher, after which CI publishes every release through OIDC. The broker's npm token has no 2FA bypass, so every npm write needs a one-time password from the user: one call publishes, a second call with the next code adds the trusted publisher. The verb refuses any package that already exists.

```json
{ "owner": "cldmv", "repo": "new-thing", "package": "@cldmv/new-thing", "otp": "123456" }
```

📦 **Full parameter reference: [docs/TOOLS.md](docs/TOOLS.md#npm_scaffold)**

### 🛡️ **Org-Wide Security Alerts**

`report_security_alerts` lists every open Dependabot, CodeQL and secret-scanning alert — for one repo or across everything an owner has — using the org-level endpoints where the token can read them and a per-repo sweep where it can't. Secret values are never returned.

🛡️ **Full parameter reference: [docs/TOOLS.md](docs/TOOLS.md#report_security_alerts)**

### 🚢 **Release PR Discovery**

`report_release_prs` finds every open release PR across an owner's repos and says which ones still lack their per-version changelog file — the list an agent needs during a mass update.

🚢 **Full parameter reference: [docs/TOOLS.md](docs/TOOLS.md#report_release_prs)**

### 🔧 **Extensible By Design**

The broker presents its **own** MCP contract to the agent — a proxied tool's schema and response are not required to match the hosted MCP's exactly. Adding a custom verb or extending a proxied tool with new parameters follows a documented pattern, not a one-off hack.

🔧 **How to add one: [docs/TOOLS.md § Extending this](docs/TOOLS.md#extending-this-adding-a-new-custom-verb-or-augmented-tool)**

### 📦 **One-Command Install & Upgrade**

`sudo node deploy/install.mjs` handles first install and every upgrade: builds under the checkout's own owner (no `chown`, ever), merges shipped config defaults over the deployed config, lets you choose how PATs are stored at rest, and runs a post-deploy smoke test.

📦 **Full prerequisites, PAT scopes, and flags: [deploy/README.md](deploy/README.md)**

---

## ✨ What's New

### Latest: v0.7.0 (October 2026)

- **`issue_labels`: edit labels without replacing the set.** The new write verb adds, removes or swaps individual labels on an issue or PR (`swap { prefix: "status: ", to: "status: verified" }` moves a status in one call), so the priority, area and type labels next to it are never dropped the way they are by `issue_write`'s whole-set `labels`. Unknown label names are refused unless `create_missing` is set, and the call returns the resulting set.
- **`issue_write` warns about the replacement.** Its advertised description now says that `labels` replaces the whole set and points at `issue_labels`.
- **Dependencies.** MCP SDK 1.32.1 and a patched `proxy-addr` (CVE-2026-90711) at runtime; `@cldmv/configs` 1.3.0 and other dev-tooling bumps.
- [View full v0.7.0 Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.7.0.md)

### Recent Releases

- **v0.6.1** (October 2026) — MCP SDK 1.32.0 (same-origin redirects only) and a refreshed vitest toolchain; no broker source changes ([Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.6.1.md))
- **v0.6.0** (October 2026) — Compact per-repo roll-up, filters and flow tier for `report_security_alerts`, and release-readiness analysis for `report_release_prs` ([Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.6.0.md))
- **v0.5.1** (October 2026) — The installer keeps the existing secrets backend instead of prompting on every upgrade ([Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.5.1.md))
- **v0.5.0** (October 2026) — New `report_security_alerts` and `report_release_prs` verbs, and a permission 403 is no longer mistaken for a rate limit ([Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.5.0.md))

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
    report_security_alerts.ts  open Dependabot/CodeQL/secret alerts, one repo or org-wide
    report_release_prs.ts  open release PRs + whether each has its changelog file
    report_ci_status.ts  tiered CI status for a PR or every open PR in a repo
    rest-client.ts       shared rate-limit-floor + call-budget REST helpers
    issue_labels.ts      add/remove/swap/set labels on an issue or PR (write PAT)
    npm_scaffold.ts      create an npm package + its trusted publisher (npm token + user OTP)
    npm-registry.ts      the npm registry requests npm_scaffold makes
    npm-tarball.ts       minimal npm tarball builder for the placeholder
    review_thread.ts     resolve/reply PR review threads (write PAT)
    link_issue.ts         addClosingIssueReference (App token) — DEFERRED, not wired in
deploy/
  install.mjs       interactive installer — first install AND upgrade (sudo node)
  install.sh        optional Linux bootstrap — set up node, then hand off to install.mjs
  lib/              installer pieces (config merge, secret store, system ops, smoke test, npm token setup)
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

- **[Tools Reference](docs/TOOLS.md)** — every custom and augmented tool: `report_unlabeled`, `report_security_alerts`, `report_release_prs`, `report_ci_status`, the `pull_request_read` `ciVerbosity` extension, `issue_labels`, `npm_scaffold`, `resolve_review_thread`/`reply_review_thread`, and how to add a new one
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

Published on npm as [`@cldmv/gh-broker`](https://www.npmjs.com/package/@cldmv/gh-broker). It's a systemd daemon, not a typical CLI tool — install it with [`deploy/install.mjs`](deploy/README.md), not `npm install -g`.
