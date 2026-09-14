import type { Octokit } from "@octokit/core";

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
 * Fan-out safety: scanning "every repo" can mean dozens of repos x hundreds of
 * issues/PRs each. Three independent caps bound the damage, and a rate-limit read on
 * every response means we back off before GitHub does it for us:
 *  - `maxRepos` caps how many repos get enumerated when `repo` is omitted.
 *  - `perRepoLimit` caps items fetched per repo, per resource type (issues, pulls).
 *  - `maxApiCalls` is a hard ceiling on total REST calls made by one invocation,
 *    regardless of the two caps above (a defense against a misconfigured caller
 *    raising both past what's sane for a single MCP call).
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
const PAGE_SIZE = 100;
/**
 * Stop proactively once remaining requests drop to this fraction of the token's OWN
 * rate limit (read from `x-ratelimit-limit` on every response — GitHub's REST limit is
 * 5000/hr for an authenticated PAT/App token today, but this must not hardcode that:
 * it can differ by token type/tier, and hardcoding it silently stops working correctly
 * if GitHub changes the number). Leaves headroom for other broker traffic sharing the
 * same PAT, rather than waiting to actually get a 403.
 */
const RATE_LIMIT_FLOOR_RATIO = 0.02;
/** Absolute floor used when `x-ratelimit-limit` is missing/unparseable, or the
 *  ratio-based floor would round to something smaller than this. */
const RATE_LIMIT_FLOOR_MIN = 20;

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

class RateLimited extends Error {
	readonly retryAfterSeconds?: number;
	constructor(retryAfterSeconds?: number) {
		super("rate limited");
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

class CallBudget {
	private remaining: number;
	constructor(max: number) {
		this.remaining = max;
	}
	/** Throws CallBudgetExhausted once the budget is spent. */
	spend(): void {
		if (this.remaining <= 0) throw new CallBudgetExhausted();
		this.remaining--;
	}
}

class CallBudgetExhausted extends Error {
	constructor() {
		super("call budget exhausted");
	}
}

/** Runs one octokit.request call, charging the budget and checking rate-limit headers. */
async function req<T>(octokit: Octokit, budget: CallBudget, route: string, params: Record<string, unknown>): Promise<T[]> {
	budget.spend();
	try {
		const res = await octokit.request(route, params);
		const headers = res.headers as Record<string, string> | undefined;
		const remainingHeader = headers?.["x-ratelimit-remaining"];
		if (remainingHeader !== undefined) {
			const remaining = Number(remainingHeader);
			const limit = Number(headers?.["x-ratelimit-limit"]);
			const floor = Number.isFinite(limit) ? Math.max(RATE_LIMIT_FLOOR_MIN, Math.ceil(limit * RATE_LIMIT_FLOOR_RATIO)) : RATE_LIMIT_FLOOR_MIN;
			if (remaining <= floor) throw new RateLimited();
		}
		return res.data as T[];
	} catch (err) {
		if (err instanceof RateLimited) throw err;
		const status = (err as { status?: number; response?: { headers?: Record<string, string> } }).status;
		if (status === 403 || status === 429) {
			const retryAfter = (err as { response?: { headers?: Record<string, string> } }).response?.headers?.["retry-after"];
			throw new RateLimited(retryAfter ? Number(retryAfter) : undefined);
		}
		throw err;
	}
}

/** Paginates a listing endpoint up to `limit` items, stopping at a short last page. */
async function paginate<T>(
	octokit: Octokit,
	budget: CallBudget,
	route: string,
	params: Record<string, unknown>,
	limit: number
): Promise<T[]> {
	const out: T[] = [];
	let page = 1;
	while (out.length < limit) {
		const batch = await req<T>(octokit, budget, route, { ...params, per_page: PAGE_SIZE, page });
		if (batch.length === 0) break;
		out.push(...batch);
		if (batch.length < PAGE_SIZE) break;
		page++;
	}
	return out.length > limit ? out.slice(0, limit) : out;
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
