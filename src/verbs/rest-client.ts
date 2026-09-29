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
		const status = (err as { status?: number; response?: { headers?: Record<string, string> } }).status;
		if (status === 403 || status === 429) {
			const retryAfter = (err as { response?: { headers?: Record<string, string> } }).response?.headers?.["retry-after"];
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
