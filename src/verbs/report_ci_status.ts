/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/report_ci_status.ts
 *	@Date: 2026-09-29T02:39:40+00:00 (1790649580)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T11:30:58-07:00 (1790965858)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import type { Octokit } from "@octokit/core";
import { CallBudget, CallBudgetExhausted, RateLimited, paginate, reqOne } from "./rest-client.ts";

/**
 * Custom verb: report_ci_status — CI health for a PR (or every open PR in a repo),
 * at a verbosity the caller chooses: counts only by default, escalating to
 * run/job detail, failing-step detail, and finally a tail of the failing job's log.
 *
 * Run/job/step classification is built on the GitHub Actions REST API
 * (`/actions/runs`, `/actions/runs/{id}/jobs`), NOT the Checks API
 * (`get_check_runs`, already proxied via `pull_request_read`) — verified live that
 * the configured read PAT has Actions access but not Checks access (fine-grained
 * PAT permissions are separate scopes). Building on Actions avoids needing a PAT
 * permission change to ship this.
 *
 * Tier 3's log fetch instead goes through the hosted MCP's own `get_job_logs` tool
 * (`fetchFailedJobLogs`, injected by the caller — router.ts has the upstream/token
 * this verb doesn't) rather than a hand-rolled REST call: `get_job_logs` already
 * does exactly this (`run_id` + `failed_only: true` fetches every failing job in a
 * run in one call, with its own `tail_lines`), so there's no reason to duplicate
 * it. One call per failing RUN, not per failing job. This means tier-3 log fetches
 * are NOT counted by the CallBudget below (that only tracks direct `octokit.request`
 * calls and their rate-limit headers) — an accepted gap, not an oversight: an
 * upstream-forwarded MCP call exposes no rate-limit headers to inspect, and the
 * fan-out is already bounded (one call per ACTUALLY-failing run, not per PR).
 *
 * Classification (run/job/step all share this): `status !== "completed"` is
 * "pending"; a completed run/job/step is "failed" unless its conclusion is
 * success/neutral/skipped (those three are non-blocking outcomes, not failures).
 *
 * Fan-out: verbosity >= 1 detail (job/step calls, and >= 3's log fetch) is only
 * ever spent on runs/jobs that are ACTUALLY failing — a healthy PR costs exactly
 * one call regardless of verbosity. When `pull` is omitted, only PRs with at least
 * one failure are included in the result (see rest-client.ts for the shared
 * call-budget + rate-limit-floor mechanics, identical to report_unlabeled's).
 */

export type Verbosity = 0 | 1 | 2 | 3;

/**
 * Fetches every failing job's log (already tailed to `tailLines`) for one workflow
 * run, keyed by job id — the shape `get_job_logs` returns with `failed_only: true`.
 * Injected by the caller (router.ts), which holds the upstream/token this verb
 * doesn't. Absent (or a lookup miss for a given job) just means no `logTail` on
 * that failure — best-effort, never a hard failure of the whole report.
 */
export type FailedJobLogsFetcher = (runId: number, tailLines: number) => Promise<Map<number, string>>;

export interface ReportCiStatusInput {
	owner: string;
	repo: string;
	/** PR number; omit to scan every open PR in the repo. */
	pull?: number;
	verbosity?: Verbosity;
	/** Tier-3 only: tail lines of the failing job's log. Default 200, hard cap 2000. */
	logLines?: number;
	/** Safety cap on open PRs scanned when `pull` is omitted. Default 50, hard cap 200. */
	maxPulls?: number;
	/** Hard ceiling on total REST calls for this invocation. Default 250, hard cap 1000. */
	maxApiCalls?: number;
}

export interface CiSummary {
	passed: number;
	failed: number;
	pending: number;
}

export interface CiStepFailure {
	name: string;
	number: number;
	conclusion: string;
	durationMs: number;
}

export interface CiFailure {
	workflow: string;
	job: string;
	runId: number;
	runUrl: string;
	conclusion: string;
	/** Tier >= 2: the job's failing steps. */
	steps?: CiStepFailure[];
	/**
	 * Tier 3: tail of the JOB's combined log (not per-step — GitHub's job log is one
	 * concatenated stream across all steps; reliably slicing it per-step would need
	 * parsing timestamp/group markers, which is fragile. The job-level tail almost
	 * always contains the actual failure output anyway.
	 */
	logTail?: string;
}

export type TruncatedReason = "max-pulls" | "max-api-calls" | "rate-limited" | "max-detail";

interface Truncation {
	truncated: true;
	truncatedReason: TruncatedReason;
	retryAfterSeconds?: number;
}

export interface CiStatusResult extends Partial<Truncation> {
	pull: number;
	summary: CiSummary;
	failures?: CiFailure[];
}

export interface ReportCiStatusResult extends Partial<Truncation> {
	scanned: { pulls: number };
	results: CiStatusResult[];
}

const DEFAULT_LOG_LINES = 200;
const HARD_LOG_LINES = 2000;
const DEFAULT_MAX_PULLS = 50;
const HARD_MAX_PULLS = 200;
const DEFAULT_MAX_DETAIL = 10;
const HARD_MAX_DETAIL = 50;
const DEFAULT_MAX_API_CALLS = 250;
const HARD_MAX_API_CALLS = 1000;

interface RawRun {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	html_url: string;
}

interface RawStep {
	name: string;
	status: string;
	conclusion: string | null;
	number: number;
	started_at: string | null;
	completed_at: string | null;
}

interface RawJob {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	html_url: string;
	steps?: RawStep[];
}

type Outcome = "passed" | "failed" | "pending";

/** Non-blocking completed conclusions — everything else completed counts as failed. */
const NON_FAILING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

function classify(status: string, conclusion: string | null): Outcome {
	if (status !== "completed") return "pending";
	return conclusion !== null && NON_FAILING_CONCLUSIONS.has(conclusion) ? "passed" : "failed";
}

function stepDurationMs(step: RawStep): number {
	if (!step.started_at || !step.completed_at) return 0;
	return new Date(step.completed_at).getTime() - new Date(step.started_at).getTime();
}

function truncationFrom(err: unknown): Truncation | undefined {
	if (err instanceof RateLimited) {
		return { truncated: true, truncatedReason: "rate-limited", ...(err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : {}) };
	}
	if (err instanceof CallBudgetExhausted) return { truncated: true, truncatedReason: "max-api-calls" };
	return undefined;
}

async function computeForPull(
	octokit: Octokit,
	budget: CallBudget,
	owner: string,
	repo: string,
	pullNumber: number,
	headSha: string,
	verbosity: Verbosity,
	logLines: number,
	fetchFailedJobLogs?: FailedJobLogsFetcher
): Promise<CiStatusResult> {
	const summary: CiSummary = { passed: 0, failed: 0, pending: 0 };
	const failures: CiFailure[] = [];
	try {
		const runs = await paginate<RawRun>(
			octokit,
			budget,
			"GET /repos/{owner}/{repo}/actions/runs",
			{ owner, repo, head_sha: headSha },
			100,
			(d) => (d as { workflow_runs: RawRun[] }).workflow_runs
		);

		const failedRuns: RawRun[] = [];
		for (const run of runs) {
			const outcome = classify(run.status, run.conclusion);
			summary[outcome]++;
			if (outcome === "failed") failedRuns.push(run);
		}

		if (verbosity >= 1) {
			for (const run of failedRuns) {
				const jobs = await paginate<RawJob>(
					octokit,
					budget,
					"GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
					{ owner, repo, run_id: run.id },
					100,
					(d) => (d as { jobs: RawJob[] }).jobs
				);
				// One get_job_logs call per FAILING RUN (not per job) — failed_only:true
				// already returns every failing job's log in that run at once.
				const logsByJobId = verbosity >= 3 && fetchFailedJobLogs ? await fetchFailedJobLogs(run.id, logLines) : undefined;
				for (const job of jobs) {
					if (classify(job.status, job.conclusion) !== "failed") continue;
					const failure: CiFailure = { workflow: run.name, job: job.name, runId: run.id, runUrl: run.html_url, conclusion: job.conclusion ?? "unknown" };
					if (verbosity >= 2) {
						failure.steps = (job.steps ?? [])
							.filter((s) => classify(s.status, s.conclusion) === "failed")
							.map((s) => ({ name: s.name, number: s.number, conclusion: s.conclusion ?? "unknown", durationMs: stepDurationMs(s) }));
					}
					const logTail = logsByJobId?.get(job.id);
					if (logTail !== undefined) failure.logTail = logTail;
					failures.push(failure);
				}
			}
		}
	} catch (err) {
		const t = truncationFrom(err);
		if (t) return { pull: pullNumber, summary, ...(failures.length ? { failures } : {}), ...t };
		throw err;
	}

	const result: CiStatusResult = { pull: pullNumber, summary };
	if (verbosity >= 1) result.failures = failures;
	return result;
}

function clampVerbosity(v: number | undefined): Verbosity {
	return Math.min(Math.max(v ?? 0, 0), 3) as Verbosity;
}

/**
 * CI status for a PR whose head sha is already known — skips the PR lookup
 * `reportCiStatus` would otherwise make. Used by router.ts's `pull_request_read`
 * augmentation, which already has the PR (and its head sha) from the forwarded
 * upstream response.
 */
export async function ciStatusForHeadSha(
	octokit: Octokit,
	owner: string,
	repo: string,
	pullNumber: number,
	headSha: string,
	opts: { verbosity?: number; logLines?: number; maxApiCalls?: number; fetchFailedJobLogs?: FailedJobLogsFetcher } = {}
): Promise<CiStatusResult> {
	const budget = new CallBudget(Math.min(opts.maxApiCalls ?? DEFAULT_MAX_API_CALLS, HARD_MAX_API_CALLS));
	return computeForPull(
		octokit,
		budget,
		owner,
		repo,
		pullNumber,
		headSha,
		clampVerbosity(opts.verbosity),
		Math.min(opts.logLines ?? DEFAULT_LOG_LINES, HARD_LOG_LINES),
		opts.fetchFailedJobLogs
	);
}

/**
 * CI status for a whole list of PRs whose head shas are already known — used by
 * router.ts's `list_pull_requests` augmentation. Returns one result per input, in
 * order. One call budget and rate-limit floor are shared across the list, and the
 * list stops being evaluated the moment either runs out: every PR from there on gets
 * an empty summary plus the same `truncated`/`truncatedReason`.
 *
 * Detail (tier >= 1) is capped at the first `maxDetail` PRs (default 10, hard cap 50).
 * Later PRs still get their tier-0 counts, flagged `truncated: true` with
 * `truncatedReason: "max-detail"` so the caller can tell the detail was withheld
 * rather than that those PRs are healthy.
 */
export async function ciStatusForHeads(
	octokit: Octokit,
	owner: string,
	repo: string,
	heads: Array<{ number: number; sha: string }>,
	opts: { verbosity?: number; logLines?: number; maxDetail?: number; maxApiCalls?: number; fetchFailedJobLogs?: FailedJobLogsFetcher } = {}
): Promise<CiStatusResult[]> {
	const budget = new CallBudget(Math.min(opts.maxApiCalls ?? DEFAULT_MAX_API_CALLS, HARD_MAX_API_CALLS));
	const verbosity = clampVerbosity(opts.verbosity);
	const logLines = Math.min(opts.logLines ?? DEFAULT_LOG_LINES, HARD_LOG_LINES);
	const maxDetail = Math.min(Math.max(opts.maxDetail ?? DEFAULT_MAX_DETAIL, 0), HARD_MAX_DETAIL);

	const results: CiStatusResult[] = [];
	let stopped: Truncation | undefined;
	for (const [i, head] of heads.entries()) {
		if (stopped) {
			results.push({ pull: head.number, summary: { passed: 0, failed: 0, pending: 0 }, ...stopped });
			continue;
		}
		const detailed = i < maxDetail;
		const r = await computeForPull(octokit, budget, owner, repo, head.number, head.sha, detailed ? verbosity : 0, logLines, opts.fetchFailedJobLogs);
		if (r.truncated) {
			stopped = { truncated: true, truncatedReason: r.truncatedReason as TruncatedReason, ...(r.retryAfterSeconds !== undefined ? { retryAfterSeconds: r.retryAfterSeconds } : {}) };
			results.push(r);
		} else if (!detailed && verbosity >= 1) {
			results.push({ ...r, truncated: true, truncatedReason: "max-detail" });
		} else {
			results.push(r);
		}
	}
	return results;
}

export async function reportCiStatus(
	octokit: Octokit,
	input: ReportCiStatusInput,
	fetchFailedJobLogs?: FailedJobLogsFetcher
): Promise<CiStatusResult | ReportCiStatusResult> {
	const verbosity = clampVerbosity(input.verbosity);
	const logLines = Math.min(input.logLines ?? DEFAULT_LOG_LINES, HARD_LOG_LINES);
	const maxApiCalls = Math.min(input.maxApiCalls ?? DEFAULT_MAX_API_CALLS, HARD_MAX_API_CALLS);
	const budget = new CallBudget(maxApiCalls);

	if (input.pull !== undefined) {
		const pullNumber = input.pull;
		try {
			const pr = await reqOne<{ head: { sha: string } }>(octokit, budget, "GET /repos/{owner}/{repo}/pulls/{pull_number}", {
				owner: input.owner,
				repo: input.repo,
				pull_number: pullNumber
			});
			return await computeForPull(octokit, budget, input.owner, input.repo, pullNumber, pr.head.sha, verbosity, logLines, fetchFailedJobLogs);
		} catch (err) {
			const t = truncationFrom(err);
			if (t) return { pull: pullNumber, summary: { passed: 0, failed: 0, pending: 0 }, ...t };
			throw err;
		}
	}

	const maxPulls = Math.min(input.maxPulls ?? DEFAULT_MAX_PULLS, HARD_MAX_PULLS);
	let pulls: Array<{ number: number; head: { sha: string } }>;
	try {
		pulls = await paginate(octokit, budget, "GET /repos/{owner}/{repo}/pulls", { owner: input.owner, repo: input.repo, state: "open" }, maxPulls);
	} catch (err) {
		const t = truncationFrom(err);
		if (t) return { scanned: { pulls: 0 }, results: [], ...t };
		throw err;
	}

	const results: CiStatusResult[] = [];
	let scanned = 0;
	let aggregateTruncation: Truncation | undefined;
	for (const p of pulls) {
		const r = await computeForPull(octokit, budget, input.owner, input.repo, p.number, p.head.sha, verbosity, logLines, fetchFailedJobLogs);
		if (r.truncated) {
			// Didn't finish evaluating this PR — don't count it as scanned, but surface
			// it (and stop entirely: the budget/rate limit is gone for the next PR too).
			results.push(r);
			aggregateTruncation = { truncated: true, truncatedReason: r.truncatedReason as TruncatedReason, ...(r.retryAfterSeconds !== undefined ? { retryAfterSeconds: r.retryAfterSeconds } : {}) };
			break;
		}
		scanned++;
		if (r.summary.failed > 0) results.push(r);
	}
	if (!aggregateTruncation && pulls.length === maxPulls) aggregateTruncation = { truncated: true, truncatedReason: "max-pulls" };

	return { scanned: { pulls: scanned }, results, ...aggregateTruncation };
}

/** JSON Schema advertised to the agent for report_ci_status. */
export const REPORT_CI_STATUS_SCHEMA = {
	type: "object" as const,
	required: ["owner", "repo"],
	additionalProperties: false,
	properties: {
		owner: { type: "string", description: "repository owner (org/user login) — selects the read credential" },
		repo: { type: "string", description: "repository name" },
		pull: { type: "number", description: "PR number; omit to scan every open PR in the repo (only PRs with a failure are included in the result)" },
		verbosity: {
			type: "number",
			enum: [0, 1, 2, 3],
			default: 0,
			description: "0: pass/fail/pending counts only. 1: + which run/job failed (workflow, job, runId, runUrl). 2: + which step in that job failed. 3: + a tail of the failing job's log."
		},
		logLines: { type: "number", description: `tier-3 only: tail lines of the failing job's log (default ${DEFAULT_LOG_LINES}, hard cap ${HARD_LOG_LINES})` },
		maxPulls: { type: "number", description: `safety cap on open PRs scanned when pull is omitted (default ${DEFAULT_MAX_PULLS}, hard cap ${HARD_MAX_PULLS})` },
		maxApiCalls: { type: "number", description: `hard ceiling on total REST calls this invocation makes (default ${DEFAULT_MAX_API_CALLS}, hard cap ${HARD_MAX_API_CALLS})` }
	}
};
