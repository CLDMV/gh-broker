/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/report_unlabeled.ts
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
import { CallBudget, CallBudgetExhausted, RateLimited, paginate } from "./rest-client.ts";

/**
 * Custom verb: report_unlabeled — issues/PRs with no labels, for one repo or every
 * repo an owner has.
 *
 * Why a custom verb: the hosted GitHub MCP has no "no labels" filter and no
 * cross-repo aggregation — `list_issues`/`list_pull_requests` are single-repo, and
 * finding the unlabeled subset means paging through everything and filtering
 * client-side. This composes plain REST reads (`octokit.request`) over the read PAT,
 * the same allowlist tier as everything it uses.
 *
 * Fan-out safety (see rest-client.ts for the shared rate-limit/budget mechanics):
 * scanning "every repo" can mean dozens of repos x hundreds of issues/PRs each.
 *  - `maxRepos` caps how many repos get enumerated when `repo` is omitted.
 *  - `perRepoLimit` caps items fetched per repo, per resource type (issues, pulls).
 *  - `maxApiCalls` is a hard ceiling on total REST calls made by one invocation.
 * Hitting any cap — or GitHub's own rate limit — stops the scan and returns whatever
 * was found so far with `truncated: true`, rather than throwing partial work away.
 */

export type Target = "issues" | "pulls" | "both";
export type State = "open" | "closed" | "all";

export interface ReportUnlabeledInput {
	owner: string;
	/** Repo name; omit to scan every non-archived repo visible to this owner's read PAT. */
	repo?: string;
	target?: Target;
	state?: State;
	/** Include draft PRs in the report (default: excluded — a draft isn't triage-ready). */
	includeDrafts?: boolean;
	/** Safety cap on repos scanned when `repo` is omitted. Default 50, hard-capped at 200. */
	maxRepos?: number;
	/** Safety cap on items fetched per repo, per resource type. Default 200, hard-capped at 1000. */
	perRepoLimit?: number;
	/** Hard ceiling on total REST calls for this invocation. Default 250, hard-capped at 1000. */
	maxApiCalls?: number;
}

export interface UnlabeledItem {
	repo: string;
	type: "issue" | "pull";
	number: number;
	title: string;
	url: string;
	createdAt: string;
}

export type TruncatedReason = "max-repos" | "max-api-calls" | "rate-limited";

export interface ReportUnlabeledResult {
	scanned: { repos: number; issues: number; pulls: number };
	unlabeled: UnlabeledItem[];
	truncated?: boolean;
	truncatedReason?: TruncatedReason;
	/** Only set when truncatedReason is "rate-limited" and GitHub sent a Retry-After. */
	retryAfterSeconds?: number;
}

const DEFAULT_MAX_REPOS = 50;
const HARD_MAX_REPOS = 200;
const DEFAULT_PER_REPO_LIMIT = 200;
const HARD_PER_REPO_LIMIT = 1000;
const DEFAULT_MAX_API_CALLS = 250;
const HARD_MAX_API_CALLS = 1000;

interface RawRepo {
	name: string;
	archived?: boolean;
}

interface RawIssueOrPull {
	number: number;
	title: string;
	html_url: string;
	created_at: string;
	labels: unknown[];
	/** Present only on items returned by the /issues endpoint that are actually PRs. */
	pull_request?: unknown;
	/** Present only on items returned by the /pulls endpoint. */
	draft?: boolean;
}

/** Lists non-archived repo names for an owner — tries the org endpoint, falls back to user. */
async function listOwnerRepos(octokit: Octokit, budget: CallBudget, owner: string, maxRepos: number): Promise<string[]> {
	let raw: RawRepo[];
	try {
		raw = await paginate<RawRepo>(octokit, budget, "GET /orgs/{owner}/repos", { owner, type: "all" }, maxRepos);
	} catch (err) {
		if (err instanceof RateLimited || err instanceof CallBudgetExhausted) throw err;
		if ((err as { status?: number }).status !== 404) throw err;
		raw = await paginate<RawRepo>(octokit, budget, "GET /users/{username}/repos", { username: owner, type: "all" }, maxRepos);
	}
	return raw.filter((r) => !r.archived).map((r) => r.name);
}

async function listUnlabeledIssues(
	octokit: Octokit,
	budget: CallBudget,
	owner: string,
	repo: string,
	state: State,
	limit: number
): Promise<{ scanned: number; unlabeled: UnlabeledItem[] }> {
	const raw = await paginate<RawIssueOrPull>(octokit, budget, "GET /repos/{owner}/{repo}/issues", { owner, repo, state }, limit);
	const issuesOnly = raw.filter((it) => !("pull_request" in it));
	const unlabeled = issuesOnly
		.filter((it) => it.labels.length === 0)
		.map((it) => toUnlabeledItem(owner, repo, "issue", it));
	return { scanned: issuesOnly.length, unlabeled };
}

async function listUnlabeledPulls(
	octokit: Octokit,
	budget: CallBudget,
	owner: string,
	repo: string,
	state: State,
	limit: number,
	includeDrafts: boolean
): Promise<{ scanned: number; unlabeled: UnlabeledItem[] }> {
	const raw = await paginate<RawIssueOrPull>(octokit, budget, "GET /repos/{owner}/{repo}/pulls", { owner, repo, state }, limit);
	const unlabeled = raw
		.filter((it) => includeDrafts || !it.draft)
		.filter((it) => it.labels.length === 0)
		.map((it) => toUnlabeledItem(owner, repo, "pull", it));
	return { scanned: raw.length, unlabeled };
}

function toUnlabeledItem(owner: string, repo: string, type: "issue" | "pull", it: RawIssueOrPull): UnlabeledItem {
	return { repo: `${owner}/${repo}`, type, number: it.number, title: it.title, url: it.html_url, createdAt: it.created_at };
}

export async function reportUnlabeled(octokit: Octokit, input: ReportUnlabeledInput): Promise<ReportUnlabeledResult> {
	const target = input.target ?? "both";
	const state = input.state ?? "open";
	const includeDrafts = input.includeDrafts ?? false;
	const maxRepos = Math.min(input.maxRepos ?? DEFAULT_MAX_REPOS, HARD_MAX_REPOS);
	const perRepoLimit = Math.min(input.perRepoLimit ?? DEFAULT_PER_REPO_LIMIT, HARD_PER_REPO_LIMIT);
	const maxApiCalls = Math.min(input.maxApiCalls ?? DEFAULT_MAX_API_CALLS, HARD_MAX_API_CALLS);
	const budget = new CallBudget(maxApiCalls);

	const unlabeled: UnlabeledItem[] = [];
	const scanned = { repos: 0, issues: 0, pulls: 0 };

	try {
		let repos: string[];
		if (input.repo) {
			repos = [input.repo];
		} else {
			repos = await listOwnerRepos(octokit, budget, input.owner, maxRepos);
		}
		scanned.repos = repos.length;

		for (const repo of repos) {
			if (target === "issues" || target === "both") {
				const out = await listUnlabeledIssues(octokit, budget, input.owner, repo, state, perRepoLimit);
				scanned.issues += out.scanned;
				unlabeled.push(...out.unlabeled);
			}
			if (target === "pulls" || target === "both") {
				const out = await listUnlabeledPulls(octokit, budget, input.owner, repo, state, perRepoLimit, includeDrafts);
				scanned.pulls += out.scanned;
				unlabeled.push(...out.unlabeled);
			}
		}
	} catch (err) {
		if (err instanceof RateLimited) {
			return { scanned, unlabeled, truncated: true, truncatedReason: "rate-limited", ...(err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : {}) };
		}
		if (err instanceof CallBudgetExhausted) {
			return { scanned, unlabeled, truncated: true, truncatedReason: "max-api-calls" };
		}
		throw err;
	}

	return { scanned, unlabeled };
}

/** JSON Schema advertised to the agent for report_unlabeled. */
export const REPORT_UNLABELED_SCHEMA = {
	type: "object" as const,
	required: ["owner"],
	additionalProperties: false,
	properties: {
		owner: { type: "string", description: "repository owner (org/user login) — selects the read credential" },
		repo: { type: "string", description: "repository name; omit to scan every non-archived repo visible to this owner's read PAT" },
		target: { type: "string", enum: ["issues", "pulls", "both"], description: "what to scan for missing labels", default: "both" },
		state: { type: "string", enum: ["open", "closed", "all"], description: "issue/PR state to scan", default: "open" },
		includeDrafts: { type: "boolean", description: "include draft PRs in the report (default: excluded)", default: false },
		maxRepos: { type: "number", description: `safety cap on repos scanned when repo is omitted (default ${DEFAULT_MAX_REPOS}, hard cap ${HARD_MAX_REPOS})` },
		perRepoLimit: { type: "number", description: `safety cap on items scanned per repo, per resource type (default ${DEFAULT_PER_REPO_LIMIT}, hard cap ${HARD_PER_REPO_LIMIT})` },
		maxApiCalls: { type: "number", description: `hard ceiling on total REST calls this invocation makes (default ${DEFAULT_MAX_API_CALLS}, hard cap ${HARD_MAX_API_CALLS})` }
	}
};
