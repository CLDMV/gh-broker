# @cldmv/gh-broker

A local **credential-routing MCP proxy** for GitHub. It lets an autonomous agent read and write GitHub issues/PRs across multiple orgs **without ever possessing a token** — the agent gets to *act*, never to *hold* the credential.

## Why

The hosted GitHub MCP authenticates with one token per server, so multi-org means many servers (tool-list bloat) and the token sits in an agent-readable config file. A classic PAT spans orgs but is coarse; a GitHub App gives bot attribution and can't drive the MCP. `gh` and raw PATs are readable by the agent (`gh auth token`, `cat ~/.claude.json`). None satisfy: **user identity + least-privilege + multi-org + one server + the agent cannot exfiltrate the secret.**

## How

A small daemon (this package) runs as a dedicated **`gh-broker` system user** and:

- holds per-org **read-scoped** and **write-scoped** fine-grained PATs (systemd-encrypted, in memory only);
- routes the right PAT by **repo owner + read/write mode** on each call;
- exposes a **config-driven, default-deny** toolset — mostly **proxied** to GitHub's hosted MCP (which already does labels, type, issue fields, dedup), plus a few **custom verbs** for gaps (currently `link_issue` → the explicit `addClosingIssueReference` closing link);
- talks to the agent over a **Unix socket** (bytes only; no token crosses).

The agent (uid 1003, rootless docker, no passwordless sudo — verified) cannot read another user's mode-0400 secrets, so the boundary is real.

Full design + threat model: `~/.claude/designs/github-mcp-broker.md`.

## Layout

```
src/
  index.ts          entry — load config + creds, start server
  config.ts         load + validate config.json
  secrets.ts        resolve cred refs from $CREDENTIALS_DIRECTORY (systemd creds)
  router.ts         allowlist (default-deny) + owner/mode → PAT + dispatch
  upstream.ts       pool of MCP clients to the hosted GitHub MCP (per-token, Bearer)
  catalog.ts        build the advertised tool list (real upstream schemas + custom)
  server.ts         Unix-socket MCP server toward the agent (StdioServerTransport)
  verbs/link_issue.ts  custom verb: addClosingIssueReference
  audit.ts          structured audit log (never tokens)
deploy/
  provision.sh      Phase 0 — RUN AS ROOT (user/creds/unit)
  gh-broker.service systemd unit (hardened)
  README.md         PAT scopes + build/deploy/wiring
config.example.json
```

## Status

Code complete and **agent-side smoke-tested**: the Unix-socket MCP server (`StdioServerTransport` over the socket), the `initialize` handshake, `tools/list` (curated catalog), and the router's default-deny allowlist + owner/mode→PAT routing all verified over a live socket with dummy creds — including that a non-allowlisted tool is refused at execution. Remaining before use: **live validation against GitHub** (needs the real PATs — the upstream forward + `link_issue`, incl. confirming any `addClosingIssueReference` preview header), then running under systemd. See `deploy/README.md` to provision.

## Install / build

```sh
npm ci
npm run typecheck
npm run build
```

Private (not published) — it's an internal security daemon.
