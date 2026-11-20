/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/core/router-core.ts
 *	@Date: 2026-11-14T00:00:00-08:00 (1794643200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T15:18:20-08:00 (1794698300)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The library-facing router core (design #175 §1's split row, §2a/§2f): the dispatch
 * layer the daemon's Router wrapper calls — the custom-verb switch, the augmented
 * forwards, and the interfaces they dispatch through. This module is library surface:
 * it must never import the daemon's host modules (secrets.ts, paths.ts, server.ts,
 * index.ts, the audit() sink, the concrete OtpGate/GhcrService classes). Credentials
 * come only through the injected TokenResolver; the wrapper (src/router.ts) owns the
 * allowlist, the OTP gate, the owner resolution and every audit row.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "@octokit/core";
import type { NpmConfig, TokenResolver, ToolRule } from "./types.ts";

// The dispatch verbs are imported through the old src/verbs/* re-export shims, not their
// src/core/verbs/ homes, so the suite's module mocks keep intercepting: tests mock the old
// paths (tests/otp-router.test.vitest.mts mocks ../src/verbs/npm_scaffold.ts), and a mock
// only reaches importers of the mocked path. The shims re-export into src/core/ and add no
// host code — the boundary test resolves through them. Slice 6's test re-cut goes direct.

// DEFERRED: link_issue is App-token-only and not wired in — see dispatchCustomVerb's
// commented case (the App-authenticated client stays wrapper-side and would arrive via
// RouteDeps when this is wired).
// import { linkIssue, type LinkIssueInput } from "../verbs/link_issue.ts";
import {
	resolveReviewThread,
	replyReviewThread,
	type ResolveReviewThreadInput,
	type ReplyReviewThreadInput
} from "../verbs/review_thread.ts";
import { reportUnlabeled, type ReportUnlabeledInput } from "../verbs/report_unlabeled.ts";
import { reportDependents, type ReportDependentsInput } from "../verbs/report_dependents.ts";
import { reportSecurityAlerts, type ReportSecurityAlertsInput } from "../verbs/report_security_alerts.ts";
import { reportReleasePrs, type ReportReleasePrsInput } from "../verbs/report_release_prs.ts";
import { reportReleaseChanges, type ReportReleaseChangesInput } from "../verbs/report_release_changes.ts";
import { reportAlertStatus, type ReportAlertStatusInput } from "../verbs/report_alert_status.ts";
import { issueLabels, type IssueLabelsInput } from "../verbs/issue_labels.ts";
import { reportCiStatus, ciStatusForHeadSha, ciStatusForHeads, type ReportCiStatusInput, type FailedJobLogsFetcher } from "../verbs/report_ci_status.ts";
import { npmScaffold } from "../verbs/npm_scaffold.ts";
import { minimizeComment, type MinimizeCommentInput } from "../verbs/minimize_comment.ts";
import { deleteBranch, type DeleteBranchInput } from "../verbs/delete_branch.ts";
import { dismissAlert, type DismissAlertInput } from "../verbs/dismiss_alert.ts";
import { NpmRegistry } from "../verbs/npm-registry.ts";

/** What the router needs from the upstream (hosted-MCP) client pool. */
export interface Upstream {
	forward(tool: string, args: Record<string, unknown>, token: string, signal?: AbortSignal): Promise<CallToolResult>;
}

/**
 * The ghcr verbs the Router dispatches for ghcr_push / ghcr_push_status / ghcr_tags
 * (design #175 §2f). The daemon injects its GhcrService (host-only — it owns the
 * background job queue and config.ghcr's credentials, so it never moves into the library);
 * a host may inject any implementation. Whatever a verb returns is JSON-serialized into
 * the tool response by the Router, exactly as today.
 */
export interface GhcrVerbs {
	push(input: unknown): Promise<unknown>;
	status(input: unknown): unknown;
	tags(input: unknown): Promise<unknown>;
}

/** What the dispatch layer runs with — today's shapes, nothing invented. */
export interface RouteDeps {
	/** The only credential path (design #175 §2a). */
	resolveToken: TokenResolver;
	upstream: Upstream;
	/**
	 * The call's cancellation signal (design #175 §2b): invoke's ctx.signal combined with
	 * its timeoutMs via AbortSignal.any. It reaches Octokit as request.signal and the MCP
	 * transport as its signal. Absent on the daemon path — the daemon passes no signal
	 * today, and its behavior is pinned unchanged.
	 */
	signal?: AbortSignal;
	/**
	 * The npm integration — npm_scaffold's registry base + scopes. Availability required
	 * it before the tool was served, so the dispatch may assume it is present there.
	 */
	npm?: NpmConfig;
}

/**
 * The Octokit client a custom/augmented dispatch runs on, with the call's signal wired
 * (design #175 §2b). Without a signal this is exactly `new Octokit({ auth })` — the
 * daemon path, byte-identical.
 */
function client(deps: RouteDeps, token: string): Octokit {
	return new Octokit({ auth: token, ...(deps.signal ? { request: { signal: deps.signal } } : {}) });
}

/** Build a name→rule index for O(1) allowlist checks. (Moved here from src/config.ts —
 * the invoke surface needs it and config.ts drags the daemon's host imports; re-exported
 * from there so the old import path keeps working.) */
export function indexTools(tools: ToolRule[]): Map<string, ToolRule> {
	return new Map(tools.map((t) => [t.name, t]));
}

/** Tools that create a repo, whose PAT is picked by the org the repo lands in. */
export const REPO_CREATING = new Set(["create_repository", "fork_repository"]);

/**
 * The org a new repo lands in. Upstream creates it in the PAT user's own account when
 * `organization` is left out, so it's required here, and it must be a configured owner. Repos
 * are only created in orgs: upstream sends a configured user-owner's name to the org endpoint,
 * which 404s. For a fork, `owner` is the repo being forked and `organization` is where the
 * fork goes, so the write PAT is the destination's. create_repository also needs `private`
 * said explicitly, so a repo's visibility is never left to a default.
 */
export function creationOwner(tool: string, args: Record<string, unknown>, owners: { [owner: string]: { read: string; write: string } }): string {
	if (typeof args.organization !== "string" || !args.organization) {
		throw new Error(`tool "${tool}": "organization" is required (the org the repo is created in); gh-broker doesn't create repos in a personal account`);
	}
	const org = args.organization.toLowerCase();
	if (!Object.hasOwn(owners, org)) throw new Error(`no credentials configured for owner "${org}" — add it to config.owners + creds`);
	if (tool === "create_repository" && typeof args.private !== "boolean") {
		throw new Error('tool "create_repository": "private" is required, true or false; a repo\'s visibility is never left to a default');
	}
	return org;
}

/**
 * actions_run_trigger's delete_workflow_run_logs method removes a run's logs, which are the
 * record of what a run did. The other methods (dispatch, re-run, cancel) stay, behind the gate.
 */
export function refuseLogDeletion(args: Record<string, unknown>): void {
	if (args.method === "delete_workflow_run_logs") throw new Error('tool "actions_run_trigger": method "delete_workflow_run_logs" is not allowed in gh-broker; a run\'s logs are kept');
}

/** Derive the repo owner from a tool call's arguments, so we pick the right PAT. */
export function extractOwner(args: Record<string, unknown>): string | undefined {
	if (typeof args.owner === "string" && args.owner) return args.owner.toLowerCase();
	// Many org-scoped tools (list_org_repository_security_advisories, get_team_members, …)
	// name the org as `org` rather than `owner`; for routing, org === owner.
	if (typeof args.org === "string" && args.org) return args.org.toLowerCase();
	if (typeof args.query === "string") {
		const m = args.query.match(/\brepo:([^/\s]+)\/[^\s]+|\b(?:org|user):([^\s]+)/i);
		const hit = m?.[1] ?? m?.[2];
		if (hit) return hit.toLowerCase();
	}
	if (typeof args.repository === "string" && args.repository.includes("/")) {
		return args.repository.split("/")[0]?.toLowerCase();
	}
	return undefined;
}

/**
 * The dispatch decision the Router and invoke share (design #175 §1's split row): a
 * custom rule runs the local verb, an augment rule the post-processed forward, anything
 * else a plain forward to the hosted MCP.
 */
export async function dispatchCall(deps: RouteDeps, rule: ToolRule, tool: string, args: Record<string, unknown>, owner: string, token: string, person: string): Promise<CallToolResult> {
	return rule.custom
		? dispatchCustom(deps, tool, args, owner, token, person)
		: rule.augment
			? dispatchAugmented(deps, tool, args, owner, token)
			: forwardCall(deps.upstream, tool, args, token, deps.signal);
}

/**
 * A plain forward, with the call's signal when there is one (design #175 §2b). Without a
 * signal this is today's exact three-argument call — the daemon path, whose call shape
 * is pinned byte-identical by the router suite.
 */
export function forwardCall(upstream: Upstream, tool: string, args: Record<string, unknown>, token: string, signal?: AbortSignal): Promise<CallToolResult> {
	return signal ? upstream.forward(tool, args, token, signal) : upstream.forward(tool, args, token);
}

/**
 * The locally dispatched custom verbs. `token` is the call's already-resolved
 * (owner, mode) PAT; the npm_scaffold case resolves its two extra credentials itself
 * through the resolver. Everything here is injected — no store, no fs, no clock.
 */
export async function dispatchCustom(deps: RouteDeps, tool: string, args: Record<string, unknown>, owner: string, token: string, person: string): Promise<CallToolResult> {
	switch (tool) {
		// DEFERRED: link_issue (App-token-only addClosingIssueReference) is not wired in — see docs.
		// Re-enable by restoring this case + the import above + the catalog block, adding a
		// link_issue allowlist entry to config, and configuring config.app + owner installationId.
		// The App-authenticated client is wrapper-side (src/router.ts's appAuth) and would
		// arrive via RouteDeps; the rest of the case needs only the resolved token.
		// case "link_issue": {
		// 	const octokit = <the App octokit for owner, from deps>;
		// 	if (!octokit) {
		// 		throw new Error(`link_issue needs a GitHub App for "${owner}": set config.app + owners.${owner}.installationId + the app key cred (addClosingIssueReference is App-token-only — not available to fine-grained PATs)`);
		// 	}
		// 	const out = await linkIssue(octokit, args as unknown as LinkIssueInput);
		// 	return { content: [{ type: "text", text: `linked: PR ${out.pullRequestId} → issue ${out.issueId}` }] };
		// }
		case "resolve_review_thread": {
			// PAT-usable (Pull requests: write) — run on the resolved write PAT, not the App token.
			const octokit = client(deps, token);
			const out = await resolveReviewThread(octokit, args as unknown as ResolveReviewThreadInput);
			return { content: [{ type: "text", text: `thread ${out.threadId}: isResolved=${out.isResolved}` }] };
		}
		case "reply_review_thread": {
			const octokit = client(deps, token);
			const out = await replyReviewThread(octokit, args as unknown as ReplyReviewThreadInput);
			return { content: [{ type: "text", text: `replied: ${out.url}` }] };
		}
		case "issue_labels": {
			// Per-label REST endpoints (Issues: write) on the resolved write PAT.
			const octokit = client(deps, token);
			const out = await issueLabels(octokit, args as unknown as IssueLabelsInput);
			return { content: [{ type: "text", text: JSON.stringify(out) }] };
		}
		case "report_unlabeled": {
			const octokit = client(deps, token);
			const out = await reportUnlabeled(octokit, args as unknown as ReportUnlabeledInput);
			return { content: [{ type: "text", text: JSON.stringify(out) }] };
		}
		case "report_security_alerts": {
			const octokit = client(deps, token);
			const out = await reportSecurityAlerts(octokit, args as unknown as ReportSecurityAlertsInput);
			return { content: [{ type: "text", text: JSON.stringify(out) }] };
		}
		case "report_dependents": {
			const octokit = client(deps, token);
			const out = await reportDependents(octokit, args as unknown as ReportDependentsInput, deps.npm?.registry ? { registry: deps.npm.registry } : {});
			return { content: [{ type: "text", text: JSON.stringify(out) }] };
		}
		case "report_release_prs": {
			const octokit = client(deps, token);
			const out = await reportReleasePrs(octokit, args as unknown as ReportReleasePrsInput);
			return { content: [{ type: "text", text: JSON.stringify(out) }] };
		}
		case "report_release_changes": {
			const octokit = client(deps, token);
			const out = await reportReleaseChanges(octokit, args as unknown as ReportReleaseChangesInput);
			return { content: [{ type: "text", text: JSON.stringify(out) }] };
		}
		case "report_alert_status": {
			const octokit = client(deps, token);
			const out = await reportAlertStatus(octokit, args as unknown as ReportAlertStatusInput);
			return { content: [{ type: "text", text: JSON.stringify(out) }] };
		}
		case "report_ci_status": {
			const octokit = client(deps, token);
			const reportArgs = args as unknown as ReportCiStatusInput;
			const out = await reportCiStatus(octokit, reportArgs, makeJobLogsFetcher(deps.upstream, owner, reportArgs.repo, token, deps.signal));
			return { content: [{ type: "text", text: JSON.stringify(out) }] };
		}
		case "npm_scaffold": {
			const npm = deps.npm!; // availability already required it
			// The GitHub side only reads (repo metadata, package.json, workflow file), so it
			// runs on the read PAT even though the verb is a write — both credentials come
			// from the resolver (design §2a). The npm token is not mode-scoped; the request
			// carries the verb's mode.
			// A resolver may return null (no access) — §2a says the caller turns that into the
			// typed no-access error rather than handing null to a client. Unreachable on the
			// daemon (config validation guarantees both refs; npm_scaffold is only served when
			// the npm token is stored), but invoke's foreign resolvers make it reachable.
			const githubToken = await deps.resolveToken({ person, owner, mode: "read", kind: "github" });
			if (!githubToken) throw new Error(`no credentials configured for owner "${owner}" — add it to config.owners + creds`);
			const npmToken = await deps.resolveToken({ person, owner, mode: "write", kind: "npm" });
			if (!npmToken) throw new Error(`no npm token configured — add npm.token to the config`);
			const octokit = client(deps, githubToken);
			const registry = new NpmRegistry({ token: npmToken, ...(npm.registry ? { registry: npm.registry } : {}) });
			const out = await npmScaffold(args, { octokit, registry, scopes: npm.scopes });
			return { content: [{ type: "text", text: JSON.stringify(out) }] };
		}
		case "minimize_comment": {
			const out = await minimizeComment(client(deps, token), args as unknown as MinimizeCommentInput);
			return { content: [{ type: "text", text: JSON.stringify(out) }] };
		}
		case "delete_branch": {
			const out = await deleteBranch(client(deps, token), args as unknown as DeleteBranchInput);
			return { content: [{ type: "text", text: JSON.stringify(out) }] };
		}
		case "dismiss_alert": {
			const out = await dismissAlert(client(deps, token), args as unknown as DismissAlertInput);
			return { content: [{ type: "text", text: JSON.stringify(out) }] };
		}
		default:
			throw new Error(`custom verb "${tool}" not implemented`);
	}
}

/**
 * A failing-run's job logs, via the hosted MCP's own `get_job_logs` tool
 * (`failed_only: true` fetches every failing job in the run in one call) rather
 * than a hand-rolled REST call — see report_ci_status.ts's FailedJobLogsFetcher
 * doc comment for why. Best-effort: any failure here (bad shape, upstream error)
 * just yields an empty map — report_ci_status treats a lookup miss as "no
 * logTail for this job", never a hard failure of the whole report.
 */
function makeJobLogsFetcher(upstream: Upstream, owner: string, repo: string, token: string, signal?: AbortSignal): FailedJobLogsFetcher {
	return async (runId, tailLines) => {
		const map = new Map<number, string>();
		try {
			const result = await forwardCall(upstream, "get_job_logs", { owner, repo, run_id: runId, failed_only: true, return_content: true, tail_lines: tailLines }, token, signal);
			const textBlock = result.content?.find((c) => (c as { type?: string }).type === "text") as { text?: string } | undefined;
			if (!textBlock?.text) return map;
			const parsed = JSON.parse(textBlock.text) as { logs?: Array<{ job_id?: unknown; logs_content?: unknown }> };
			for (const entry of parsed.logs ?? []) {
				if (typeof entry.job_id === "number" && typeof entry.logs_content === "string") map.set(entry.job_id, entry.logs_content);
			}
		} catch {
			/* best-effort — see doc comment */
		}
		return map;
	};
}

/**
 * Forwards to the hosted MCP like a plain proxy, then post-processes the result.
 * gh-broker presents its own MCP contract — a proxied tool's response is not
 * required to match the hosted MCP's shape verbatim (see [[broker-owns-its-mcp-contract]]
 * in project memory). `ciVerbosity`/`logLines` are gh-broker's own extension
 * params, stripped before forwarding since the upstream schema doesn't know them.
 *
 * Opt-in only: with no `ciVerbosity`, this is byte-identical to a plain forward —
 * augmenting every `pull_request_read` call by default would add an unrequested
 * API call (and cost) to every ordinary PR read.
 *
 * Best-effort: if the upstream response isn't the JSON-text shape expected (a
 * format this broker doesn't control), the original result is returned unmodified
 * rather than thrown — a shape mismatch should degrade to "no CI data added," not
 * break an otherwise-successful PR read.
 */
export async function dispatchAugmented(deps: RouteDeps, tool: string, args: Record<string, unknown>, owner: string, token: string): Promise<CallToolResult> {
	switch (tool) {
		case "pull_request_read": {
			const { ciVerbosity, logLines, ...upstreamArgs } = args as Record<string, unknown> & { ciVerbosity?: number; logLines?: number };
			const result = await forwardCall(deps.upstream, tool, upstreamArgs, token, deps.signal);
			if (ciVerbosity === undefined) return result;
			if ((upstreamArgs.method ?? "get") !== "get") return result; // only the single-PR "get" shape is augmentable

			const textBlock = result.content?.find((c) => (c as { type?: string }).type === "text") as { text?: string } | undefined;
			if (!textBlock?.text) return result;
			let pr: unknown;
			try {
				pr = JSON.parse(textBlock.text);
			} catch {
				return result;
			}
			const p = pr as { number?: unknown; head?: { sha?: unknown } };
			if (typeof p.number !== "number" || typeof p.head?.sha !== "string") return result;

			const repo = String(upstreamArgs.repo ?? "");
			const octokit = client(deps, token);
			const ci = await ciStatusForHeadSha(octokit, owner, repo, p.number, p.head.sha, {
				verbosity: Number(ciVerbosity),
				logLines: logLines !== undefined ? Number(logLines) : undefined,
				fetchFailedJobLogs: makeJobLogsFetcher(deps.upstream, owner, repo, token, deps.signal)
			});
			textBlock.text = JSON.stringify({ ...(pr as object), ci });
			return result;
		}
		case "list_pull_requests": {
			// Same opt-in contract as pull_request_read, applied to each item of the list.
			// Detail is capped by maxDetail; see ciStatusForHeads for the shared budget.
			const { ciVerbosity, logLines, maxDetail, ...upstreamArgs } = args as Record<string, unknown> & { ciVerbosity?: number; logLines?: number; maxDetail?: number };
			const result = await forwardCall(deps.upstream, tool, upstreamArgs, token, deps.signal);
			if (ciVerbosity === undefined) return result;

			const textBlock = result.content?.find((c) => (c as { type?: string }).type === "text") as { text?: string } | undefined;
			if (!textBlock?.text) return result;
			let list: unknown;
			try {
				list = JSON.parse(textBlock.text);
			} catch {
				return result;
			}
			if (!Array.isArray(list)) return result;
			const heads: Array<{ number: number; sha: string }> = [];
			for (const item of list as Array<{ number?: unknown; head?: { sha?: unknown } }>) {
				if (typeof item?.number === "number" && typeof item.head?.sha === "string") heads.push({ number: item.number, sha: item.head.sha });
			}
			if (heads.length === 0) return result;

			const repo = String(upstreamArgs.repo ?? "");
			const octokit = client(deps, token);
			const cis = await ciStatusForHeads(octokit, owner, repo, heads, {
				verbosity: Number(ciVerbosity),
				logLines: logLines !== undefined ? Number(logLines) : undefined,
				maxDetail: maxDetail !== undefined ? Number(maxDetail) : undefined,
				fetchFailedJobLogs: makeJobLogsFetcher(deps.upstream, owner, repo, token, deps.signal)
			});
			const byNumber = new Map(cis.map((c) => [c.pull, c]));
			textBlock.text = JSON.stringify((list as Array<{ number?: unknown }>).map((item) => (typeof item?.number === "number" && byNumber.has(item.number) ? { ...item, ci: byNumber.get(item.number) } : item)));
			return result;
		}
		default:
			return forwardCall(deps.upstream, tool, args, token, deps.signal);
	}
}
