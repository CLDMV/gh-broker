# @cldmv/gh-broker

A local **credential-routing MCP proxy** for GitHub. It lets an autonomous agent read and write GitHub issues/PRs across multiple orgs **without ever possessing a token** — the agent gets to *act*, never to *hold* the credential.

## Why

The hosted GitHub MCP authenticates with one token per server, so multi-org means many servers (tool-list bloat) and the token sits in an agent-readable config file. A classic PAT spans orgs but is coarse; a GitHub App gives bot attribution and can't drive the MCP. `gh` and raw PATs are readable by the agent (`gh auth token`, `cat ~/.claude.json`). None satisfy: **user identity + least-privilege + multi-org + one server + the agent cannot exfiltrate the secret.**

## How

A small daemon (this package) runs as a dedicated **`gh-broker` system user** and:

- holds per-org **read-scoped** and **write-scoped** fine-grained PATs, read from an agent-unreadable secret store — `systemd-creds` (encrypted at rest, default) or a plaintext file, chosen at install — via `cred:` references in a token-free config, into memory only;
- routes the right PAT by **repo owner + read/write mode** on each call;
- exposes a **config-driven, default-deny** toolset — mostly **proxied** to GitHub's hosted MCP (which already does labels, type, issue fields, dedup), plus **custom verbs** for gaps the hosted MCP has no tool for: `resolve_review_thread` / `reply_review_thread` (resolve or reply to a PR review thread — e.g. Copilot's comments — via the `resolveReviewThread` / `addPullRequestReviewThreadReply` GraphQL mutations, which run on the write PAT). A third verb, `link_issue` (the App-token-only `addClosingIssueReference` closing link), is implemented but currently **deferred** — not advertised or callable; see [`deploy/README.md`](deploy/README.md#enabling-link_issue-github-app--deferred);
- talks to the agent over a **Unix socket** (bytes only; no token crosses).

The agent (uid 1003, rootless docker, no passwordless sudo — verified) cannot read another user's mode-0400 secrets, so the boundary is real. The **agent-as-separate-user** model — the users, the bridge group, and the permissions that make the boundary real, as a reproducible example setup — is documented in [`docs/agent-user-model.md`](docs/agent-user-model.md).

Full design + threat model: `~/.claude/designs/github-mcp-broker.md`.

## Layout

```
src/
  index.ts          entry — resolve paths, load config + secrets, start server
  paths.ts          platform-neutral config/secrets path resolution
  config.ts         load + validate the token-free config
  secrets.ts        resolve cred refs from the secrets file (provider seam)
  router.ts         allowlist (default-deny) + owner/mode → PAT + dispatch
  upstream.ts       pool of MCP clients to the hosted GitHub MCP (per-token, Bearer)
  catalog.ts        build the advertised tool list (real upstream schemas + custom)
  server.ts         Unix-socket MCP server toward the agent (StdioServerTransport)
  verbs/review_thread.ts  custom verbs: resolve/reply PR review threads (write PAT)
  verbs/link_issue.ts     addClosingIssueReference (App token) — DEFERRED, not wired in
  audit.ts          structured audit log (never tokens)
deploy/
  install.mjs       interactive installer — first install AND upgrade (sudo node)
  install.sh        optional Linux bootstrap — set up node, then hand off to install.mjs
  lib/              installer pieces (config merge, secret store, system ops, smoke test)
  gh-broker.service systemd unit (hardened)
  README.md         prerequisites + PAT scopes + install/upgrade/wiring
docs/
  deploy-architecture.md  config merge, secret store, node handling, installer flow
  agent-user-model.md     the agent-as-separate-user isolation model (example setup)
config.example.json  shipped defaults (token-free); merged into the deployed config
```

## Status

**Deployed and in production** — running under systemd, brokering live GitHub reads and writes across the configured org. The Unix-socket MCP server, the default-deny allowlist, and owner/mode→PAT routing are all exercised in normal use. `link_issue` (App-token-only) is implemented but deferred — see [`deploy/README.md`](deploy/README.md#enabling-link_issue-github-app--deferred). Install/upgrade with `sudo node deploy/install.mjs` (see [`deploy/README.md`](deploy/README.md)).

## ✨ What's New

### Latest: v0.3.0 (September 2026)

- **Portable Node installer — first install and upgrade in one command** — A single idempotent `deploy/install.mjs` replaces the old shell scripts: it merges shipped config defaults over the deployed config, lets the operator choose how PATs are stored at rest (`systemd-creds`, encrypted, by default; or a portable plaintext file), auto-migrates and can rotate existing credentials, adds platform-neutral path resolution, and runs a post-deploy smoke test — interactive by default or fully non-interactive via CLI flags. The broker's runtime request path is unchanged; this release is entirely deploy/secret handling and its hardening.
- [View full v0.3.0 Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.3.0.md)

### Recent Releases

- **v0.2.5** (September 2026) — Security hotfix: bump the `npm_and_yarn` group across 1 directory (4 updates; [#40](https://github.com/CLDMV/gh-broker/pull/40)) ([Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.2.5.md))
- **v0.2.4** (September 2026) — Sign redirected security PRs by mapping the `CLDMV_BOT_*` GPG secrets ([#42](https://github.com/CLDMV/gh-broker/pull/42)) ([Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.2.4.md))
- **v0.2.3** (September 2026) — Route the Required PR Check mirror to `cldmv-runners` on private repos ([#35](https://github.com/CLDMV/gh-broker/pull/35)) ([Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.2.3.md))
- **v0.2.2** (August 2026) — Bump `@hono/node-server` transitive to 2.0.12 ([#11](https://github.com/CLDMV/gh-broker/pull/11)) ([Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.2.2.md))

📚 For the complete version history, see the [docs/changelog/](https://github.com/CLDMV/gh-broker/tree/master/docs/changelog/) folder.

## Install / build

```sh
npm ci
npm run typecheck
npm run build
```

Private (not published) — it's an internal security daemon.
