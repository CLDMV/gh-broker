# Tools reference

Every tool the broker advertises falls into one of three categories, set per entry in `config.tools` (`src/types.ts` `ToolRule`) and dispatched accordingly in `router.ts`:

| Category | Config flag | What happens | Example |
|---|---|---|---|
| **Proxied** | (neither flag) | Forwarded to the hosted GitHub MCP untouched — the advertised schema and response are exactly what the hosted MCP defines (the one addition: `issue_write`'s description carries a warning that `labels` replaces the whole set). | `list_issues`, `pull_request_read` (base behavior) |
| **Custom** | `"custom": true` | Handled entirely locally — no call to the hosted MCP at all. The broker builds its own `Octokit` from the resolved PAT and does the work itself (raw REST/GraphQL, or composing several reads). | `report_unlabeled`, `report_security_alerts`, `report_release_prs`, `report_ci_status`, `issue_labels`, `npm_scaffold`, `resolve_review_thread`, `reply_review_thread` |
| **Augmented** | `"augment": true` | Forwarded to the hosted MCP like a plain proxy, then the broker post-processes the result before returning it. | `pull_request_read`'s `ciVerbosity` extension |

The broker is not obligated to make a proxied tool's advertised schema or response match the hosted MCP's exactly — see the `augment` category above. It presents its own MCP contract to the agent; a tool can extend what the hosted MCP offers.

This document covers the **custom** and **augmented** tools — the ones that don't exist in the hosted MCP at all, or that gh-broker extends beyond what it offers. For everything else, see the hosted GitHub MCP's own tool documentation; gh-broker just routes the credential.

---

## `report_unlabeled`

Issues and/or PRs with no labels, for one repo or every non-archived repo an owner has. Read-only, `mode: "read"`.

```json
{
	"owner": "cldmv",
	"repo": "gh-broker",
	"target": "both",
	"state": "open"
}
```

| Param | Type | Default | Notes |
|---|---|---|---|
| `owner` | string | — (required) | Selects the read credential. |
| `repo` | string | — | Omit to scan every non-archived repo visible to this owner's read PAT (enumerated via `GET /orgs/{owner}/repos`, falling back to `GET /users/{owner}/repos` on a 404). |
| `target` | `"issues"` \| `"pulls"` \| `"both"` | `"both"` | |
| `state` | `"open"` \| `"closed"` \| `"all"` | `"open"` | |
| `includeDrafts` | boolean | `false` | A draft PR with no labels isn't triage-ready by default; include it explicitly if wanted. |
| `maxRepos` | number | 50 (hard cap 200) | Only relevant when `repo` is omitted. |
| `perRepoLimit` | number | 200 (hard cap 1000) | Items scanned per repo, per resource type. |
| `maxApiCalls` | number | 250 (hard cap 1000) | Hard ceiling on total REST calls for one invocation, regardless of the two caps above. |

Real example — `CLDMV/gh-broker` scanned for unlabeled issues/PRs (`state: "all"`):

```json
{
	"scanned": { "repos": 1, "issues": 4, "pulls": 54 },
	"unlabeled": [
		{ "repo": "CLDMV/gh-broker", "type": "issue", "number": 9, "title": "Deploy/runtime is Linux + systemd only, despite the app being portable Node", "url": "https://github.com/CLDMV/gh-broker/issues/9", "createdAt": "2026-08-03T02:04:22Z" }
	]
}
```

**Fan-out safety.** Hitting a rate limit or the `maxApiCalls` ceiling mid-scan returns `truncated: true` plus a `truncatedReason` (`"rate-limited"` | `"max-api-calls"` | `"max-repos"`) and whatever was already found, rather than discarding partial results. The rate-limit floor is not a hardcoded number — every response's `x-ratelimit-limit` header is read and the scan backs off at 2% of that token's real limit (floored at an absolute minimum for low-limit tokens), so it's correct regardless of which token type is configured.

---

## `report_security_alerts`

Every open Dependabot, code-scanning (CodeQL) and secret-scanning alert, for one repo or everything an owner has. Read-only, `mode: "read"`, `custom: true`.

```json
{
	"owner": "cldmv",
	"types": ["dependabot", "codeql", "secrets"]
}
```

| Param | Type | Default | Notes |
|---|---|---|---|
| `owner` | string | — (required) | Selects the read credential. |
| `repo` | string | — | Omit to cover every non-archived repo the owner has. When given, only the per-repo endpoints are used. |
| `types` | array of `"dependabot"` \| `"codeql"` \| `"secrets"` | all three | |
| `maxRepos` | number | 200 (hard cap 500) | Only relevant to a per-repo sweep (see below). |
| `alertLimit` | number | 500 (hard cap 5000) | Alerts fetched per type in org mode, or per repo per type in a per-repo sweep. |
| `maxApiCalls` | number | 700 (hard cap 3000) | Hard ceiling on total REST calls for one invocation. |
| `summaryOnly` | boolean | `false` | Return only the per-repo roll-up and counts. An org run is about 700 KB with the alert list and a few KB without it; `alertsOmitted` says how many alerts were left out. |
| `minSeverity` | `"critical"` \| `"high"` \| `"medium"` \| `"low"` | — | Keep only alerts at or above this severity. Secret-scanning alerts have no severity and are always kept. |
| `repos` | string[] | — | Keep only these repos (names, with or without the owner prefix, case-insensitive). |
| `classify` | boolean | `false` | Add each repo's flow tier to its roll-up row. About 3 REST calls per repo that has alerts. |

**Org-level first, per-repo as the fallback.** For each requested type the verb asks the org-level endpoint (`/orgs/{owner}/dependabot/alerts`, `/code-scanning/alerts`, `/secret-scanning/alerts`) — a handful of calls for the whole owner. If that endpoint is not available to the token (a user-owned account answers 404, a PAT without org alert access answers 403), that type alone falls back to one call per repo. `scope` in the result says which path each type took, and `disabled` counts the repos where a type is switched off or unreadable (code scanning and secret scanning are off on many repos, and that is a normal answer rather than an error).

**Per-repo roll-up.** Every result carries `byRepo`: one row per repo with at least one alert (after the filters), worst first (criticals, then highs, then total), with `total`, per-type counts (`dependabot`, `codeql`, `secrets`) and `critical` / `high` / `medium` / `low`. With `classify: true` each row also has `tier` and `tierSignals`:

| `tier` | Meaning |
|---|---|
| `v4` | `.github/workflows/next-release.yml` exists on the default branch, and `next` carries its own work (or there is no `dev` branch). |
| `dev-trunk` | A v4 repo with a `dev` branch that differs from the default branch while `next` is missing or equal to the default branch (scaffold only). |
| `non-v4` | No `next-release.yml` on the default branch — even if `next` / `hotfixes` branches exist. |

The tier is a structural signal, not a verdict. A stale `dev` branch on a repo whose `next` happens to equal `master` right after a release reads as `dev-trunk`; `tierSignals` carries the raw facts (`v4Workflow`, `defaultBranch`, `next`, `dev`, `nextEqualsDefault`, `devDiffersFromDefault`) so a caller can cross-check.

Each alert is normalized to one shape: `repo`, `type`, `number`, `severity`, `summary`, `url`, `createdAt`, plus type-specific fields — Dependabot adds `package`, `ecosystem`, `manifest`, `scope`, `ghsa`, `cve`, `vulnerableRange` and `patchedVersion` (the patched version for the range that actually matches the alert); code scanning adds `rule`, `tool` and `location`; secret scanning adds `secretType` and `validity`. Results are sorted critical-first, then by repo and number. Secret scanning returns metadata only: the secret value GitHub sends back is dropped and never leaves the broker.

```json
{
	"scanned": {},
	"scope": { "dependabot": "org", "codeql": "per-repo", "secrets": "per-repo" },
	"counts": { "dependabot": { "high": 1 }, "codeql": {}, "secrets": {} },
	"alerts": [
		{ "repo": "CLDMV/gh-broker", "type": "dependabot", "number": 19, "severity": "medium", "summary": "…", "url": "https://github.com/CLDMV/gh-broker/security/dependabot/19", "createdAt": "2026-10-02T20:10:30Z", "package": "ip-address", "ecosystem": "npm", "manifest": "package-lock.json", "scope": "runtime", "ghsa": "GHSA-j6r3-76f7-8jcv", "vulnerableRange": "<= 10.7.0", "patchedVersion": "10.7.1" }
	],
	"disabled": { "codeql": 140, "secrets": 140 }
}
```

**"Open" is the default-branch view.** An alert's state tracks the default branch, so one already fixed on `next` but not yet released still reads as open until the release lands.

**Fan-out safety** works like `report_unlabeled`'s: hitting `maxRepos`, `alertLimit`, `maxApiCalls` or GitHub's rate limit returns what was found so far with `truncated: true` and a `truncatedReason` (`"max-repos"` | `"max-alerts"` | `"max-api-calls"` | `"rate-limited"`). A type that was never reached is left out of `counts` rather than reported as zero. A permission or feature-disabled `403`/`404` from an alert endpoint is never mistaken for a rate limit — only a `403` that carries a `Retry-After`, an exhausted `x-ratelimit-remaining`, or a rate-limit/abuse message is.

---

## `report_release_prs`

Every open release PR for an owner (or one repo), and whether each one's per-version changelog file is already on the release branch. Built for mass updates: it tells an agent which repos have a release waiting and which of those still need a changelog written. Read-only, `mode: "read"`, `custom: true`.

```json
{
	"owner": "cldmv",
	"onlyMissing": true
}
```

| Param | Type | Default | Notes |
|---|---|---|---|
| `owner` | string | — (required) | Selects the read credential. |
| `repo` | string | — | Omit to search every repo the owner has. |
| `onlyMissing` | boolean | `false` | List only PRs that are not `ready`. `summary` still counts all of them. |
| `analyze` | boolean | `false` | Add an `analysis` block per release PR and a `verdicts` tally. About 5 more REST calls per release PR, so raise `maxApiCalls` for a whole org. With `onlyMissing`, "missing" then means "verdict other than `done`". |
| `maxApiCalls` | number | 300 (hard cap 1000) | Hard ceiling on total REST calls for one invocation. |

A release PR is an open PR carrying the `release` label, which the v4 release automation applies to both the `next → master` and the `hotfixes → master` PR. One search call covers the whole owner; each PR found then costs one call for its head/base and up to two to look for the changelog.

The version is read from the `release: vX.Y.Z - …` title. The changelog is looked up **at the PR's head commit** (not the default branch), because the file lands on `next` before the release PR merges. Both `docs/changelog/v<major>/vX.Y.Z.md` and `docs/changelogs/v<major>/vX.Y.Z.md` are checked. Each PR gets one `status`:

| `status` | Meaning |
|---|---|
| `ready` | The changelog file exists (`changelogPath` says where). |
| `needs-changelog` | The version is known but no changelog file exists (`checkedPaths` lists what was looked up). |
| `unknown-version` | The title has no `release: vX.Y.Z`, so there is nothing to look up. |

```json
{
	"scanned": { "releasePrs": 2 },
	"summary": { "ready": 1, "needsChangelog": 1, "unknownVersion": 0 },
	"releasePrs": [
		{ "repo": "CLDMV/gh-broker", "pull": 91, "url": "https://github.com/CLDMV/gh-broker/pull/91", "title": "release: v0.4.3 - …", "version": "0.4.3", "head": "next", "base": "master", "draft": false, "status": "needs-changelog", "checkedPaths": ["docs/changelog/v0/v0.4.3.md", "docs/changelogs/v0/v0.4.3.md"] }
	]
}
```

**`analyze: true`.** Each release PR gains `analysis`: `openPrs` (everything open against its release branch — `next`, or `hotfixes` — as `doc`, `dependency`, `feature` or `draft`; a doc PR's title version is read), `freshness` when a changelog exists, a `verdict`, and a one-line `reason`.

`freshness.status` compares the changelog with the PRs that actually shipped in the release (read from the release PR's commits, first line of each; docs PRs and the version bump are ignored):

| `freshness.status` | Meaning |
|---|---|
| `current` | The heading carries the release's version and every shipped PR is mentioned. |
| `minor-gap` | Every user-facing PR is mentioned; only `ci` / `chore` / `style` / `test` PRs are not (`missingInternal`). |
| `stale` | At least one user-facing PR is not mentioned (`missingUserFacing`). |
| `version-drift` | The changelog's heading names a different version than the release PR's current title. |
| `thin` | Looks like a stub (very short, or no Overview section). |

`readmeMentionsVersion` reports whether the README's What's New block names the version; it does not change the status.

The `verdict` is the release-docs decision table:

| `verdict` | When |
|---|---|
| `done` | A changelog exists and is `current` or `minor-gap`. |
| `in-flight` | It needs work and a doc PR is already open against the release branch (`docVersionMismatch` is set if that PR names a different version). |
| `wait` | It needs work and feature/fix PRs are still open against the release branch. |
| `gray` | It needs work and only dependency PRs or drafts are open. |
| `write` | No changelog exists and nothing is open against the release branch. |
| `update` | A changelog exists but is stale, drifted or thin, and nothing is open against the release branch. |
| `inspect` | The release PR title has no readable version. |

The release PR's version can change while it is open (more PRs landing on `next` can raise the bump), so a `ready` changelog is only as current as the title it was matched against — re-run the report after `next` changes. Truncation follows the same pattern as the other report verbs; the extra reasons are `"max-results"` (more than one page of release PRs matched — GitHub's search returns 100 per page) and `"incomplete-search"` (GitHub reported the search timed out).

---

## `report_ci_status`

CI health for a PR, or every open PR in a repo, at a verbosity the caller chooses. Read-only, `mode: "read"`, `custom: true`.

```json
{
	"owner": "cldmv",
	"repo": "droidsock",
	"pull": 35,
	"verbosity": 3
}
```

| Param | Type | Default | Notes |
|---|---|---|---|
| `owner`, `repo` | string | — (required) | |
| `pull` | number | — | Omit to scan every open PR in the repo — only PRs with a failure are included in the result. |
| `verbosity` | `0`-`3` | `0` | See tiers below. |
| `logLines` | number | 200 (hard cap 2000) | Tier-3 only: tail lines per failing job's log. |
| `maxPulls` | number | 50 (hard cap 200) | Only relevant when `pull` is omitted. |
| `maxApiCalls` | number | 250 (hard cap 1000) | |

### Verbosity tiers

| Tier | Adds |
|---|---|
| 0 (default) | `summary: { passed, failed, pending }` only |
| 1 | Which run/job failed: `workflow`, `job`, `runId`, `runUrl`, `conclusion` |
| 2 | + which step in that job failed, with `durationMs` |
| 3 | + a tail of the failing job's log (`logTail`) |

Detail beyond tier 0 is fetched **only for runs that are actually failing** — a healthy PR costs exactly one API call regardless of the requested verbosity.

**Classification.** A run, job, or step with `status !== "completed"` is `"pending"`. A completed one is `"failed"` unless its `conclusion` is `success`, `neutral`, or `skipped` — those three are the only non-blocking outcomes. Notably, a `cancelled` job (e.g. a matrix sibling killed after another leg failed) counts as **failed**, not skipped, matching how GitHub's own UI treats it as needing attention.

### Real example (tier 3, `CLDMV/droidsock#35`)

A dependency-bump PR with a genuine `npm ERESOLVE` peer-dependency conflict:

```json
{
	"pull": 35,
	"summary": { "passed": 6, "failed": 1, "pending": 0 },
	"failures": [
		{ "workflow": "🧪 CI Tests & Build", "job": "Build & Test (24)", "runId": 34787050719, "conclusion": "cancelled", "steps": [{ "name": "Build and Test", "number": 2, "conclusion": "cancelled", "durationMs": 16000 }] },
		{ "workflow": "🧪 CI Tests & Build", "job": "Build & Test (22.12)", "runId": 34787050719, "conclusion": "failure", "steps": [{ "name": "Build and Test", "number": 2, "conclusion": "failure", "durationMs": 8000 }], "logTail": "npm error ERESOLVE could not resolve\nnpm error While resolving: @cldmv/slothlet@3.15.1\nnpm error Found: typescript@7.0.2\n…\nnpm error peerOptional typescript@\"^6.0.3\" from @cldmv/slothlet@3.15.1\n…" }
	]
}
```

Note the first entry (a `cancelled` matrix leg) has no `logTail` even at tier 3 — the hosted MCP's `get_job_logs` (see below) only has log content for jobs whose conclusion is exactly `"failure"`, not `"cancelled"`. A lookup miss like this yields no `logTail` on that entry, never an error for the whole report.

### Tier 3's log fetch: `get_job_logs`, not a hand-rolled REST call

Tier 3 does not call GitHub's job-logs REST endpoint directly. It calls the hosted MCP's own `get_job_logs` tool (already allowlisted, plain proxied) with `failed_only: true` and the failing run's `run_id` — which returns every failing job's log **in that run** in a single call, already tailed to `logLines`. One call per failing **run**, not per failing job. This is dispatched from `router.ts`'s `makeJobLogsFetcher`, which both `report_ci_status` and the `pull_request_read` augmentation (below) share.

Because this goes through the hosted MCP rather than a direct REST call, it is **not** counted by `report_ci_status`'s own `CallBudget`/rate-limit-floor (that machinery is REST-response-header-based, and an upstream-forwarded MCP call exposes no such headers). This is an accepted gap, not an oversight — the fan-out is already bounded by "one call per actually-failing run," so it can't grow unboundedly regardless.

---

## `pull_request_read` + `ciVerbosity` (augmented)

A normal `pull_request_read` call (`method: "get"`) can carry CI status inline by adding `ciVerbosity`:

```json
{
	"owner": "cldmv",
	"repo": "droidsock",
	"pullNumber": 35,
	"method": "get",
	"ciVerbosity": 1
}
```

`ciVerbosity` (0-3, same tiers as `report_ci_status`) and `logLines` are gh-broker's own extension on top of the hosted MCP's real `pull_request_read` schema — they're stripped before the call is forwarded, since the upstream schema doesn't know them. The response comes back with a `ci` field appended, computed from the PR's head sha already present in the forwarded response (no redundant PR lookup):

```json
{
	"number": 35,
	"title": "deps: bump typescript from 6.0.3 to 7.0.2",
	"...": "…every other real pull_request_read field, untouched…",
	"ci": { "pull": 35, "summary": { "passed": 6, "failed": 1, "pending": 0 }, "failures": [ "…same shape as report_ci_status…" ] }
}
```

**Opt-in only.** Omitting `ciVerbosity` makes this call byte-identical to a plain forward — augmenting every `pull_request_read` by default would add an unrequested API call (and cost) to every ordinary PR read. Only `method: "get"` is augmentable; any other method (`get_diff`, `get_files`, …) forwards untouched even if `ciVerbosity` is present.

**Best-effort.** If the upstream response isn't the JSON-text shape expected — a format gh-broker doesn't control — the original result is returned unmodified rather than thrown. A shape mismatch degrades to "no CI data added," never a broken PR read.

---

## `issue_labels`

Edit the labels on one issue or PR, touching only the labels named. Write, `mode: "write"`, `custom: true`, runs on the write PAT (Issues: write).

The hosted MCP's `issue_write` takes `labels` as a **replacement**: every label not in the list is removed. Changing one status label that way silently drops the priority, area and type labels next to it. Reading the set and writing the merged set back has a race, since a label someone else adds between the two calls is lost. `issue_labels` uses GitHub's per-label endpoints instead, so nothing outside the call is touched. The broker also appends a warning to the advertised `issue_write` description pointing here.

```json
{
	"owner": "cldmv",
	"repo": "gh-broker",
	"issue_number": 117,
	"swap": { "prefix": "status: ", "to": "status: implemented" }
}
```

| Param | Type | Default | Notes |
|---|---|---|---|
| `owner` | string | — (required) | Selects the write credential. |
| `repo` | string | — (required) | |
| `issue_number` | integer | — (required) | An issue or a pull-request number. PRs use the same endpoints. |
| `add` | string \| string[] | — | Append one or more labels (`POST …/issues/{n}/labels`, server-side append). Labels already on the issue are a no-op. |
| `remove` | string \| string[] | — | Remove one or more labels (`DELETE …/issues/{n}/labels/{name}` each, using the spelling already on the issue). A label the issue doesn't have is skipped: no request, not an error. |
| `swap` | `{ prefix, to }` | — | Remove every current label whose name starts with `prefix`, then add `to` (one label or several). A `to` label already on the issue is left in place rather than removed and re-added. |
| `set` | string \| string[] | — | Replace the whole set (`PUT …/issues/{n}/labels`). Only as an explicit choice; cannot be combined with `add`, `remove` or `swap`. An empty `set` is refused, so it can never clear every label. |
| `create_missing` | boolean | `false` | Create add-side labels that don't exist in the repo instead of refusing the call. |
| `color` | string | `ededed` | 6-digit hex color (with or without `#`) for labels created by `create_missing`. Anything else is refused. |

`add`, `remove` and `swap` combine freely in one call. Naming the same label on both sides is refused, and a label on the add side is never removed by a `swap` prefix match (it stays put rather than being deleted and re-added).

**Strict arguments.** The handler enforces the schema itself: an unknown key (a typo such as `remvoe`), a non-integer `issue_number`, a non-string `owner`/`repo`, a non-boolean `create_missing`, an empty list or a bad `color` refuses the call before any request. Each list holds at most 100 labels (GitHub's per-issue limit), and so does the add side as a whole.

**Write order and partial failure.** Writes run in this order: create missing labels, one POST for the whole add side, then the DELETEs. Adding before removing means a failure part-way never leaves the issue with fewer labels than it should have; a `swap` whose POST is rate-limited keeps its old status label. If any write fails, the error names what was applied and what was not, and keeps the HTTP status:

```
issue_labels: failed part-way on cldmv/gh-broker#117: API rate limit exceeded. Applied: nothing. Not applied: added [status: verified]; removed [status: in progress].
```

A failure before the first write (the read of the issue's labels, or a label lookup) is passed through unchanged; nothing was written.

**Unknown labels are refused.** Every name the call would add (`add`, `swap.to`, `set`) is looked up in the repo first. If any is missing and `create_missing` is not set, the call fails with the missing names and **nothing is written**. Names to remove are not checked, since removing an absent label is already a no-op. Matching is case-insensitive, as GitHub's is, and the repo's own spelling is what gets applied.

**Result.** Always the issue's resulting label set, plus what this call changed:

```json
{
	"issue": "cldmv/gh-broker#117",
	"labels": ["type: enhancement", "priority: medium", "status: implemented"],
	"added": ["status: implemented"],
	"removed": ["status: not started"],
	"created": []
}
```

`added` lists only labels this call asked for that were not already there; a label someone else added meanwhile shows in `labels` but not in `added`.

**Calls.** One read of the issue's current labels (which also fails a wrong issue number before anything is written), one lookup per add-side label, one create per missing label with `create_missing`, at most one POST, and one DELETE per label actually on the issue. With the 100-label caps a call makes at most a few hundred requests. `swap` and `remove` work from that first read, so a matching label added by someone else in the moments between that read and the DELETEs is not removed; nothing outside the call is ever affected.

---

## `npm_scaffold`

Create a new npm package and register its GitHub Actions trusted publisher, so the repo's own publish workflow can release it through OIDC from then on. Write, `mode: "write"`, `custom: true`. It needs the optional `npm` integration (set up by the installer, see [deploy/README.md](../deploy/README.md#npm-integration-npm_scaffold)); without it the call is refused with a message saying how to enable it.

npm only accepts a trusted publisher on a package that already exists, and that first publish needs a human's 2FA. The broker holds an npm granular access token created **without** 2FA bypass, and each call carries a one-time password the user reads from their authenticator. The token alone cannot write anything; the OTP is the human's approval for that one call. Ask the user for each code right before the call that uses it, since codes expire in about 30 seconds.

```json
{ "owner": "cldmv", "repo": "new-thing", "package": "@cldmv/new-thing", "otp": "123456" }
```

| Param | Type | Default | Notes |
|---|---|---|---|
| `owner` | string | — (required) | A configured owner. Its **read** PAT does the GitHub reads; the verb never writes to GitHub. |
| `repo` | string | — (required) | The repo whose `package.json` names the package. |
| `package` | string | — (required) | Lowercase scoped name, e.g. `@cldmv/new-thing`. Must be under a scope in `config.npm.scopes`. |
| `otp` | string | — (required) | 6–8 digit one-time password. Never logged or returned. |
| `workflow` | string | `publish.yml` | The repo's publish workflow file in `.github/workflows`; the trusted publisher names it. |

**Guardrails, checked before any npm write.**

- The scope is allowed by `config.npm.scopes`.
- The repo exists and isn't archived, its `package.json` on the default branch names exactly this package and is not `"private": true`, and `.github/workflows/<workflow>` exists there.
- The package does not exist on the registry yet. A package that exists is refused unless it is this verb's own placeholder from an earlier call (a single `0.0.0-stage` version marked `scaffoldedBy: "gh-broker"`), which is how an interrupted call resumes. The verb can never publish a version of a real package.

**What it writes.**

1. **Placeholder publish** (`PUT /<package>`, the request `npm publish` sends). The broker builds the tarball itself, so the agent supplies no files: a `package.json` (name, `0.0.0-stage`, the repo's `license` or `UNLICENSED`, repository, homepage, the `scaffoldedBy` marker) and a README pointing at the repo. Access is `public` for a public repo and `restricted` for a private one, the rule the CI publish uses too.
2. **Trusted publisher** (`POST /-/package/<package>/trust`, the request `npm trust github <package> --repo <owner>/<repo> --file <workflow> --allow-publish` sends). Permission `createPackage` is npm's internal name for publish.

**One code per write, so two calls.** npm requires a one-time password for every write, and a code works once. The first call publishes the placeholder and returns `status: "needs_otp"` with `done: ["publish"]` and `remaining: ["trust"]`, without sending the spent code again. Ask the user for the next code (after the authenticator changes) and call again: the publish is skipped, since the placeholder now exists, and the trusted publisher is added. A refused or expired code also returns `needs_otp` with what is left, and a trusted publisher that is already configured (HTTP 409) counts as done.

**Result.**

```json
{
	"status": "done",
	"package": "@cldmv/new-thing",
	"repository": "CLDMV/new-thing",
	"workflow": "publish.yml",
	"access": "public",
	"done": ["trust"],
	"skipped": ["publish"],
	"version": "0.0.0-stage",
	"url": "https://www.npmjs.com/package/@cldmv/new-thing",
	"trustId": "…",
	"message": "@cldmv/new-thing exists with a trusted publisher for CLDMV/new-thing (.github/workflows/publish.yml); its next release can publish through OIDC."
}
```

That is the second call's result; `skipped` lists the steps an earlier call already did. Any other registry or GitHub failure fails the call with npm's or GitHub's own message; neither the OTP nor the token ever appears in a result, an error or the audit log.

**Calls.** GitHub: one repo read and two file reads (read PAT). npm: one package lookup, at most one publish and one trust request.

---

## `resolve_review_thread` / `reply_review_thread`

Resolve/unresolve, or reply inside, a pull-request review thread (e.g. addressing a Copilot review comment) — gaps the hosted MCP has no tool for. Both run on the **write** PAT (`Pull requests: write`), via the `resolveReviewThread`/`unresolveReviewThread`/`addPullRequestReviewThreadReply` GraphQL mutations.

```json
{ "owner": "cldmv", "threadId": "PRRT_kwDO…", "resolve": true }
```

`threadId` is the review-thread **node id**, taken verbatim from `pull_request_read`'s `get_review_comments` method (each returned thread carries it as `id`). `resolve_review_thread` defaults to resolving; pass `resolve: false` to unresolve. `reply_review_thread` takes the same `threadId` plus a `body` (Markdown).

---

## Extending this: adding a new custom verb or augmented tool

- **Custom verb**: implement in `src/verbs/<name>.ts` (export the function + a `*_SCHEMA` JSON Schema constant), add a `case` in `router.ts`'s `dispatchCustom`, advertise it in `catalog.ts`'s `if (rule.custom)` branch, and add a `{ "name": ..., "mode": ..., "custom": true }` entry to `config.example.json`.
- **Augmented tool**: add a `case` in `router.ts`'s `dispatchAugmented` that forwards via `this.upstream.forward(...)` and post-processes the result, layer the extra schema properties onto the real fetched schema in `catalog.ts` (see the `pull_request_read` branch for the pattern), and mark the allowlist entry `"augment": true` instead of `"custom": true` — the two are mutually exclusive.
- If the new verb needs data another proxied tool already provides (like `report_ci_status`'s tier 3 needing `get_job_logs`), give `dispatchCustom`/`dispatchAugmented` access to `this.upstream` and inject a fetcher function into the verb rather than reimplementing the underlying REST call — see `router.ts`'s `makeJobLogsFetcher` for the pattern.
