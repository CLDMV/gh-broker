/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/rest-client.ts
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

/**
 * Shared REST-call machinery for custom verbs that compose plain `octokit.request()`
 * calls instead of proxying a hosted-MCP tool (currently `report_unlabeled` and
 * `report_ci_status`). Factored out once a second verb needed the identical
 * rate-limit/call-budget handling — see report_unlabeled.ts's original version for
 * the rationale (kept here, not duplicated).
 *
 * Rate-limit floor: proactively stops once remaining requests drop to 2% of the
 * token's OWN limit (read from `x-ratelimit-limit` on every response — never
 * hardcode GitHub's number, it can differ by token type/tier), floored at an
 * absolute minimum for low-limit tokens. Leaves headroom for other broker traffic
 * sharing the same PAT, rather than waiting to actually get a 403.
 */

const PAGE_SIZE = 100;
const RATE_LIMIT_FLOOR_RATIO = 0.02;
const RATE_LIMIT_FLOOR_MIN = 20;

export class RateLimited extends Error {
	readonly retryAfterSeconds?: number;
	constructor(retryAfterSeconds?: number) {
		super("rate limited");
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

export class CallBudgetExhausted extends Error {
	constructor() {
		super("call budget exhausted");
	}
}

export class CallBudget {
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

/**
 * A 403 is only a rate limit when GitHub says so — a Retry-After header, an exhausted
 * `x-ratelimit-remaining`, or a rate-limit/abuse message. Any other 403 is a permission
 * or feature-disabled answer (e.g. code scanning off for a repo) and must surface to the
 * caller with its status intact instead of being mistaken for throttling.
 */
function looksRateLimited(err: Error, headers: Record<string, string> | undefined): boolean {
	if (headers?.["retry-after"] !== undefined) return true;
	if (headers?.["x-ratelimit-remaining"] === "0") return true;
	return /rate limit|abuse|secondary/i.test(err.message);
}

/** Runs one octokit.request call, charging the budget and enforcing the rate-limit floor. */
async function doRequest(octokit: Octokit, budget: CallBudget, route: string, params: Record<string, unknown>): Promise<{ data: unknown }> {
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
		return res;
	} catch (err) {
		if (err instanceof RateLimited) throw err;
		const status = (err as { status?: number }).status;
		const headers = (err as { response?: { headers?: Record<string, string> } }).response?.headers;
		if (status === 429 || (status === 403 && looksRateLimited(err as Error, headers))) {
			const retryAfter = headers?.["retry-after"];
			throw new RateLimited(retryAfter ? Number(retryAfter) : undefined);
		}
		throw err;
	}
}

/**
 * Runs one octokit.request call expected to return a listing. `extract` pulls the
 * item array out of the response body — plain for bare-array endpoints
 * (issues/pulls/repos), overridden for endpoints that wrap the array in a named
 * field (e.g. Actions: `{ workflow_runs: [...] }`).
 */
export async function req<T>(
	octokit: Octokit,
	budget: CallBudget,
	route: string,
	params: Record<string, unknown>,
	extract: (data: unknown) => T[] = (d) => d as T[]
): Promise<T[]> {
	const res = await doRequest(octokit, budget, route, params);
	return extract(res.data);
}

/** Runs one octokit.request call expected to return a single resource (not a listing). */
export async function reqOne<T>(octokit: Octokit, budget: CallBudget, route: string, params: Record<string, unknown>): Promise<T> {
	const res = await doRequest(octokit, budget, route, params);
	return res.data as T;
}

/** Paginates a listing endpoint up to `limit` items, stopping at a short last page. */
export async function paginate<T>(
	octokit: Octokit,
	budget: CallBudget,
	route: string,
	params: Record<string, unknown>,
	limit: number,
	extract?: (data: unknown) => T[]
): Promise<T[]> {
	const out: T[] = [];
	let page = 1;
	while (out.length < limit) {
		const batch = await req<T>(octokit, budget, route, { ...params, per_page: PAGE_SIZE, page }, extract);
		if (batch.length === 0) break;
		out.push(...batch);
		if (batch.length < PAGE_SIZE) break;
		page++;
	}
	return out.length > limit ? out.slice(0, limit) : out;
}

/**
 * Paginates a listing endpoint that uses cursor pagination (`after`) instead of `page` —
 * Dependabot's alert endpoints. Follows the `rel="next"` cursor in the Link header and
 * stops at the last page or once `limit` items are collected.
 */
export async function paginateAfter<T>(octokit: Octokit, budget: CallBudget, route: string, params: Record<string, unknown>, limit: number): Promise<T[]> {
	const out: T[] = [];
	let after: string | undefined;
	while (out.length < limit) {
		const res = await doRequest(octokit, budget, route, { ...params, per_page: PAGE_SIZE, ...(after ? { after } : {}) });
		const batch = res.data;
		if (!Array.isArray(batch) || batch.length === 0) break;
		out.push(...(batch as T[]));
		const link = (res as { headers?: Record<string, string> }).headers?.link;
		const next = link ? /<[^>]*[?&]after=([^&>]+)[^>]*>;\s*rel="next"/.exec(link) : null;
		if (!next) break;
		after = decodeURIComponent(next[1]!);
	}
	return out.length > limit ? out.slice(0, limit) : out;
}

interface RawRepo {
	name: string;
	archived?: boolean;
}

/** Lists non-archived repo names for an owner — tries the org endpoint, falls back to user. */
export async function listOwnerRepos(octokit: Octokit, budget: CallBudget, owner: string, maxRepos: number): Promise<string[]> {
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
