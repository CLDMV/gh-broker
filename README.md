# @cldmv/gh-broker

**@cldmv/gh-broker** is a local **credential-routing MCP proxy** for GitHub. It lets an autonomous agent read and write issues, pull requests and more across several orgs **without ever holding a token**: the agent gets to *act*, never to *possess* the credential.

The hosted GitHub MCP authenticates with one token per server, so several orgs means several servers, and the token sits in a config file the agent can read. A classic PAT spans orgs but is coarse; a GitHub App acts as a bot and can't drive the MCP; `gh` and raw PATs are readable by the agent (`gh auth token`). gh-broker covers what none of them do together: the user's own identity, least privilege, several orgs, one server, and a secret the agent cannot exfiltrate.

It runs as a dedicated `gh-broker` system user, holds a read-scoped and a write-scoped fine-grained PAT per org in an agent-unreadable secret store (`systemd-creds` or a `0640` file), and picks the right one per call by repo owner and read/write mode. The toolset is config-driven and default-deny: mostly proxied to GitHub's hosted MCP, plus custom verbs for what the hosted MCP has no tool for, and augmented tools that extend a proxied tool's result. The agent reaches it over a permissioned Unix socket that carries MCP frames and never credential material.

> _The agent gets to act, never to hold the credential._

[![npm version]][npm_version_url] [![npm downloads]][npm_downloads_url] [![GitHub downloads]][github_downloads_url] [![Last commit]][last_commit_url] [![npm last update]][npm_last_update_url] [![Coverage]][coverage_url]

> [!NOTE]
> **Status: 0.x, in production.** Running under systemd and brokering live GitHub reads and writes. Linux and systemd only for now ([#9](https://github.com/CLDMV/gh-broker/issues/9)). `link_issue` (App-token only) is implemented but not wired in, see [deploy/README.md](deploy/README.md#enabling-link_issue-github-app--deferred).

[![Contributors]][contributors_url] [![Sponsor shinrai]][sponsor_url]

---

## ✨ What's New

### Latest: v0.8.0 (October 2026)

- **`npm_scaffold`: new npm packages without a manual first publish.** The new write verb publishes a broker-built `0.0.0-stage` placeholder and registers the repo's publish workflow as its trusted publisher, so CI publishes the first real release through OIDC. The npm token has no 2FA bypass: each write takes a one-time password from the user, so it's two calls, and the verb refuses any package that already exists.
- **`ghcr_push`: container image pushes without a registry token.** Push a `docker save` archive from a drop directory to an allowlisted `ghcr.io/<owner>/<image>` as a background job, follow it with `ghcr_push_status` and check it with `ghcr_tags`. Release tags are never overwritten, and the classic PAT stays with the broker.
- **Optional credentials.** The npm and GHCR tokens can be skipped at install; their tools stay hidden until the token is stored. The installer also takes tokens via `--secret <cred-name>=<token>`.
- [View full v0.8.0 Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.8.0.md)

### Recent Releases

- **v0.7.0** (October 2026) — `issue_labels` adds, removes or swaps single labels without replacing the set, and `issue_write` warns that its `labels` does ([Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.7.0.md))
- **v0.6.1** (October 2026) — MCP SDK 1.32.0 (same-origin redirects only) and a refreshed vitest toolchain; no broker source changes ([Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.6.1.md))
- **v0.6.0** (October 2026) — Compact per-repo roll-up, filters and flow tier for `report_security_alerts`, and release-readiness analysis for `report_release_prs` ([Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.6.0.md))
- **v0.5.1** (October 2026) — The installer keeps the existing secrets backend instead of prompting on every upgrade ([Changelog](https://github.com/CLDMV/gh-broker/blob/master/docs/changelog/v0/v0.5.1.md))

📚 For the complete version history, see the [docs/changelog/](https://github.com/CLDMV/gh-broker/tree/master/docs/changelog/) folder.

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

### 🐳 **Container Image Pushes Without a Registry Token**

`ghcr_push` pushes a `docker save` archive to `ghcr.io/<owner>/<image>:<tag>` with a classic `write:packages` PAT the agent never sees. The image must be on an allowlist, the archive must sit in a dedicated drop directory (symlinks, hard links and paths outside it are refused), and an existing release tag is never overwritten. The push runs as a background job, uploads only the blobs the registry doesn't already have, and is tracked with `ghcr_push_status`; `ghcr_tags` checks the result.

```json
{ "owner": "cldmv", "image": "hoot", "tag": "1.4.0", "archive": "hoot-1.4.0.tar" }
```

🐳 **Full parameter reference and threat model: [docs/TOOLS.md](docs/TOOLS.md#ghcr_push)**

### 🔧 **Extensible By Design**

The broker presents its **own** MCP contract to the agent — a proxied tool's schema and response are not required to match the hosted MCP's exactly. Adding a custom verb or extending a proxied tool with new parameters follows a documented pattern, not a one-off hack.

🔧 **How to add one: [docs/TOOLS.md § Extending this](docs/TOOLS.md#extending-this-adding-a-new-custom-verb-or-augmented-tool)**

### 📦 **One-Command Install & Upgrade**

`sudo node deploy/install.mjs` handles first install and every upgrade: builds under the checkout's own owner (no `chown`, ever), merges shipped config defaults over the deployed config, lets you choose how PATs are stored at rest, and runs a post-deploy smoke test.

📦 **Full prerequisites, PAT scopes, and flags: [deploy/README.md](deploy/README.md)**

---

## 📦 Installation

### Requirements

- **Linux with systemd.** The broker runs as a hardened systemd service and listens on a Unix socket.
- **Node.js 22.12.0 or later** (`engines.node` is `>=22.12.0`). The installer points `/usr/local/bin/node` at the node it runs under.
- **The agent runs as its own Linux user**, without passwordless sudo, so it can't read the broker's secrets. The model behind that is in [docs/agent-user-model.md](docs/agent-user-model.md).
- **Two fine-grained PATs per org** (read and write). The scopes are listed in [deploy/README.md](deploy/README.md).

### Install

gh-broker is a system service, not a library. The installer handles both the first install and every upgrade, and you can run it from npm or from a checkout.

From npm ([`@cldmv/gh-broker`](https://www.npmjs.com/package/@cldmv/gh-broker)), with the prebuilt bundle:

```sh
sudo npx @cldmv/gh-broker <agent-user>
```

From a checkout:

```sh
git clone https://github.com/CLDMV/gh-broker.git
cd gh-broker
sudo node deploy/install.mjs <agent-user>
```

Both take the same flags. The installer creates the service user and the socket group, builds as the checkout's owner when there's no bundle yet, merges the shipped defaults with the deployed config, stores the PATs in the backend you pick, installs the unit and runs a smoke test. Prerequisites, PAT scopes, unattended installs and every flag: [deploy/README.md](deploy/README.md).

---

## 🚀 Quick Start

Point the agent's MCP client at the socket ([deploy/README.md § 3](deploy/README.md#3-point-claude-at-the-broker)). From then on the client sees an ordinary `tools/call`, and the broker resolves the credential, routes it, and (for custom/augmented tools) does the extra work in between:

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

## 📁 Layout

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
    ghcr_push.ts         ghcr_push / ghcr_push_status / ghcr_tags (GHCR classic PAT)
    ghcr/                config policy, tar + image-archive reader, OCI registry client, push, job queue
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
config.example.json  shipped generic defaults (socket, upstream, tools allowlist)
config.sample.json   a full config with placeholder values, for reference only
```

---

## 📚 Documentation

- **[Tools Reference](docs/TOOLS.md)** — every custom and augmented tool: `report_unlabeled`, `report_security_alerts`, `report_release_prs`, `report_ci_status`, the `pull_request_read` `ciVerbosity` extension, `issue_labels`, `npm_scaffold`, `resolve_review_thread`/`reply_review_thread`, `ghcr_push`/`ghcr_push_status`/`ghcr_tags`, and how to add a new one
- **[Agent-as-Separate-User Model](docs/agent-user-model.md)** — the isolation model behind "use ≠ possession": users, groups, filesystem permissions, verified against a real host
- **[Deploy Architecture](docs/deploy-architecture.md)** — config merge, secret store backends, node handling, the installer's full flow
- **[Install Guide](deploy/README.md)** — prerequisites, PAT scopes, install/upgrade command, flags
- **[Changelog](docs/changelog/)** — per-version release notes

[![CodeFactor]][codefactor_url] [![OpenSSF Scorecard]][ossf_scorecard_url] [![npms.io score]][npms_url] [![npm unpacked size]][npm_size_url] [![Repo size]][repo_size_url]

---

## 🤝 Contributing

Bug reports and pull requests are welcome on [GitHub](https://github.com/CLDMV/gh-broker/issues). Pull requests target the `next` branch; releases ship from `next` to `master`. Run `npm run build:ci` and `npm run ci:coverage` before opening one; coverage is held at 100%.

[![Contributors]][contributors_url] [![Sponsor shinrai]][sponsor_url]

---

## 🔗 Links

- **npm**: [@cldmv/gh-broker](https://www.npmjs.com/package/@cldmv/gh-broker)
- **GitHub**: [CLDMV/gh-broker](https://github.com/CLDMV/gh-broker)
- **Issues**: [GitHub Issues](https://github.com/CLDMV/gh-broker/issues)
- **Changelog**: [docs/changelog/](https://github.com/CLDMV/gh-broker/tree/master/docs/changelog/)
- **Releases**: [GitHub Releases](https://github.com/CLDMV/gh-broker/releases)

---

## 📄 License

[![GitHub license]][github_license_url] [![npm license]][npm_license_url]

Apache-2.0 © Shinrai / CLDMV. See [LICENSE](https://github.com/CLDMV/gh-broker/blob/master/LICENSE) for the full text.

<!-- Badge definitions -->
<!-- [github release]: https://img.shields.io/github/v/release/CLDMV/gh-broker?style=for-the-badge&logo=github&logoColor=white&labelColor=181717 -->
<!-- [github_release_url]: https://github.com/CLDMV/gh-broker/releases -->
<!-- [release date]: https://img.shields.io/github/release-date/CLDMV/gh-broker?style=for-the-badge&logo=github&logoColor=white&labelColor=181717 -->
<!-- [release_date_url]: https://github.com/CLDMV/gh-broker/releases -->

[npm version]: https://img.shields.io/npm/v/%40cldmv%2Fgh-broker.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_version_url]: https://www.npmjs.com/package/@cldmv/gh-broker
[npm downloads]: https://img.shields.io/npm/dm/%40cldmv%2Fgh-broker.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_downloads_url]: https://www.npmjs.com/package/@cldmv/gh-broker
[github downloads]: https://img.shields.io/github/downloads/CLDMV/gh-broker/total?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[github_downloads_url]: https://github.com/CLDMV/gh-broker/releases
[last commit]: https://img.shields.io/github/last-commit/CLDMV/gh-broker?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[last_commit_url]: https://github.com/CLDMV/gh-broker/commits
[npm last update]: https://img.shields.io/npm/last-update/%40cldmv%2Fgh-broker?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_last_update_url]: https://www.npmjs.com/package/@cldmv/gh-broker
[coverage]: https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FCLDMV%2Fgh-broker%2Fbadges%2Fcoverage.json&style=for-the-badge&logo=vitest&logoColor=white
[coverage_url]: https://github.com/CLDMV/gh-broker/blob/badges/coverage.json
[contributors]: https://img.shields.io/github/contributors/CLDMV/gh-broker.svg?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[contributors_url]: https://github.com/CLDMV/gh-broker/graphs/contributors
[sponsor shinrai]: https://img.shields.io/github/sponsors/shinrai?style=for-the-badge&logo=githubsponsors&logoColor=white&labelColor=EA4AAA&label=Sponsor
[sponsor_url]: https://github.com/sponsors/shinrai
[codefactor]: https://img.shields.io/codefactor/grade/github/CLDMV/gh-broker?style=for-the-badge&logo=codefactor&logoColor=white&labelColor=F44A6A
[codefactor_url]: https://www.codefactor.io/repository/github/cldmv/gh-broker
[openssf scorecard]: https://img.shields.io/ossf-scorecard/github.com/CLDMV/gh-broker?style=for-the-badge&label=OpenSSF%20Scorecard
[ossf_scorecard_url]: https://scorecard.dev/viewer/?uri=github.com/CLDMV/gh-broker
[npms.io score]: https://img.shields.io/npms-io/final-score/%40cldmv%2Fgh-broker?style=for-the-badge&logo=npms&logoColor=white&labelColor=0B5D57
[npms_url]: https://npms.io/search?q=%40cldmv%2Fgh-broker
[npm unpacked size]: https://img.shields.io/npm/unpacked-size/%40cldmv%2Fgh-broker.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_size_url]: https://www.npmjs.com/package/@cldmv/gh-broker
[repo size]: https://img.shields.io/github/repo-size/CLDMV/gh-broker?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[repo_size_url]: https://github.com/CLDMV/gh-broker
[npm license]: https://img.shields.io/npm/l/%40cldmv%2Fgh-broker.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_license_url]: https://www.npmjs.com/package/@cldmv/gh-broker
[github license]: https://img.shields.io/github/license/CLDMV/gh-broker.svg?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[github_license_url]: https://github.com/CLDMV/gh-broker/blob/master/LICENSE
