# Tools reference

Every tool the broker advertises falls into one of three categories, set per entry in `config.tools` (`src/types.ts` `ToolRule`) and dispatched accordingly in `router.ts`:

| Category | Config flag | What happens | Example |
|---|---|---|---|
| **Proxied** | (neither flag) | Forwarded to the hosted GitHub MCP untouched — the advertised schema and response are exactly what the hosted MCP defines. | `list_issues`, `pull_request_read` (base behavior) |
| **Custom** | `"custom": true` | Handled entirely locally — no call to the hosted MCP at all. The broker builds its own `Octokit` from the resolved PAT and does the work itself (raw REST/GraphQL, or composing several reads). | `report_unlabeled`, `report_ci_status`, `resolve_review_thread`, `reply_review_thread` |
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
