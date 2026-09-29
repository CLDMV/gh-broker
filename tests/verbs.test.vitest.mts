import { describe, it, expect, vi, beforeEach } from "vitest";
import { linkIssue, LINK_ISSUE_SCHEMA } from "../src/verbs/link_issue.ts";
import {
	resolveReviewThread,
	replyReviewThread,
	RESOLVE_REVIEW_THREAD_SCHEMA,
	REPLY_REVIEW_THREAD_SCHEMA
} from "../src/verbs/review_thread.ts";
import { reportUnlabeled, REPORT_UNLABELED_SCHEMA } from "../src/verbs/report_unlabeled.ts";
import { reportCiStatus, REPORT_CI_STATUS_SCHEMA } from "../src/verbs/report_ci_status.ts";

describe("linkIssue", () => {
	let graphql: ReturnType<typeof vi.fn>;
	let octokit: any;

	beforeEach(() => {
		graphql = vi.fn();
		octokit = { graphql };
	});

	it("resolves node ids then creates the closing reference", async () => {
		graphql
			.mockResolvedValueOnce({ repository: { pullRequest: { id: "PR_abc" }, issue: { id: "I_xyz" } } })
			.mockResolvedValueOnce({ addClosingIssueReference: { pullRequest: { id: "PR_abc" } } });
		const out = await linkIssue(octokit, { owner: "cldmv", repo: "gh-broker", pull: 3, issue: 7 });
		expect(out).toEqual({ pullRequestId: "PR_abc", issueId: "I_xyz" });
		expect(graphql).toHaveBeenCalledTimes(2);
		// First: id resolution with the PR/issue numbers.
		expect(graphql.mock.calls[0]![1]).toEqual({ owner: "cldmv", repo: "gh-broker", pr: 3, issue: 7 });
		// Second: the mutation with the resolved node ids.
		expect(graphql.mock.calls[1]![1]).toEqual({ prId: "PR_abc", issueId: "I_xyz" });
	});

	it("throws when the PR is not found", async () => {
		graphql.mockResolvedValueOnce({ repository: { pullRequest: null, issue: { id: "I_1" } } });
		await expect(linkIssue(octokit, { owner: "cldmv", repo: "r", pull: 9, issue: 1 })).rejects.toThrow(
			/PR #9 not found in cldmv\/r/
		);
		expect(graphql).toHaveBeenCalledTimes(1); // never reaches the mutation
	});

	it("throws when the issue is not found", async () => {
		graphql.mockResolvedValueOnce({ repository: { pullRequest: { id: "PR_1" }, issue: null } });
		await expect(linkIssue(octokit, { owner: "cldmv", repo: "r", pull: 1, issue: 42 })).rejects.toThrow(
			/issue #42 not found in cldmv\/r/
		);
	});

	it("advertises a valid schema", () => {
		expect(LINK_ISSUE_SCHEMA.required).toEqual(["owner", "repo", "pull", "issue"]);
		expect(LINK_ISSUE_SCHEMA.additionalProperties).toBe(false);
	});
});

describe("resolveReviewThread", () => {
	let graphql: ReturnType<typeof vi.fn>;
	let octokit: any;

	beforeEach(() => {
		graphql = vi.fn();
		octokit = { graphql };
	});

	it("resolves a thread by default", async () => {
		graphql.mockResolvedValue({ resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } });
		const out = await resolveReviewThread(octokit, { owner: "cldmv", threadId: "PRRT_1" });
		expect(out).toEqual({ threadId: "PRRT_1", isResolved: true });
		expect(graphql.mock.calls[0]![0]).toMatch(/resolveReviewThread/);
		expect(graphql.mock.calls[0]![0]).not.toMatch(/unresolveReviewThread/);
		expect(graphql.mock.calls[0]![1]).toEqual({ threadId: "PRRT_1" });
	});

	it("unresolves a thread when resolve is false", async () => {
		graphql.mockResolvedValue({ unresolveReviewThread: { thread: { id: "PRRT_2", isResolved: false } } });
		const out = await resolveReviewThread(octokit, { owner: "cldmv", threadId: "PRRT_2", resolve: false });
		expect(out).toEqual({ threadId: "PRRT_2", isResolved: false });
		expect(graphql.mock.calls[0]![0]).toMatch(/unresolveReviewThread/);
	});

	it("throws when no thread is returned", async () => {
		graphql.mockResolvedValue({});
		await expect(resolveReviewThread(octokit, { owner: "cldmv", threadId: "PRRT_x" })).rejects.toThrow(
			/no thread returned for "PRRT_x"/
		);
	});
});

describe("replyReviewThread", () => {
	let graphql: ReturnType<typeof vi.fn>;
	let octokit: any;

	beforeEach(() => {
		graphql = vi.fn();
		octokit = { graphql };
	});

	it("posts a reply and returns the comment id + url", async () => {
		graphql.mockResolvedValue({ addPullRequestReviewThreadReply: { comment: { id: "C_1", url: "https://gh/c/1" } } });
		const out = await replyReviewThread(octokit, { owner: "cldmv", threadId: "PRRT_1", body: "ack" });
		expect(out).toEqual({ commentId: "C_1", url: "https://gh/c/1" });
		expect(graphql.mock.calls[0]![1]).toEqual({ threadId: "PRRT_1", body: "ack" });
	});

	it("rejects an empty body without calling the API", async () => {
		await expect(replyReviewThread(octokit, { owner: "cldmv", threadId: "PRRT_1", body: "   " })).rejects.toThrow(
			/body is required/
		);
		expect(graphql).not.toHaveBeenCalled();
	});

	it("throws when the reply mutation returns no comment", async () => {
		graphql.mockResolvedValue({ addPullRequestReviewThreadReply: { comment: null } });
		await expect(replyReviewThread(octokit, { owner: "cldmv", threadId: "PRRT_1", body: "hi" })).rejects.toThrow(
			/reply failed for "PRRT_1"/
		);
	});

	it("advertises valid schemas", () => {
		expect(RESOLVE_REVIEW_THREAD_SCHEMA.required).toEqual(["owner", "threadId"]);
		expect(REPLY_REVIEW_THREAD_SCHEMA.required).toEqual(["owner", "threadId", "body"]);
	});
});

describe("reportUnlabeled", () => {
	const labeledIssue = { number: 1, title: "labeled", html_url: "u1", created_at: "t1", labels: [{ name: "bug" }] };
	const unlabeledIssue = { number: 2, title: "unlabeled issue", html_url: "u2", created_at: "t2", labels: [] };
	const prViaIssuesEndpoint = { number: 3, title: "pr via issues", html_url: "u3", created_at: "t3", labels: [], pull_request: {} };
	const unlabeledPr = { number: 4, title: "unlabeled pr", html_url: "u4", created_at: "t4", labels: [], draft: false };
	const draftPr = { number: 5, title: "draft pr", html_url: "u5", created_at: "t5", labels: [], draft: true };
	const labeledPr = { number: 6, title: "labeled pr", html_url: "u6", created_at: "t6", labels: [{ name: "x" }], draft: false };

	function octokitWith(handler: (route: string, params: any) => Promise<{ data: unknown[]; headers?: Record<string, string> }>): any {
		return { request: vi.fn(handler) };
	}

	it("scans a single repo: excludes labeled items, PR-shaped issues, and draft PRs by default", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/issues") return { data: [labeledIssue, unlabeledIssue, prViaIssuesEndpoint], headers: {} };
			if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [unlabeledPr, draftPr, labeledPr], headers: {} };
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportUnlabeled(octokit, { owner: "cldmv", repo: "gh-broker" });
		expect(out.scanned).toEqual({ repos: 1, issues: 2, pulls: 3 });
		expect(out.unlabeled).toEqual([
			{ repo: "cldmv/gh-broker", type: "issue", number: 2, title: "unlabeled issue", url: "u2", createdAt: "t2" },
			{ repo: "cldmv/gh-broker", type: "pull", number: 4, title: "unlabeled pr", url: "u4", createdAt: "t4" }
		]);
		expect(out.truncated).toBeUndefined();
	});

	it("includes draft PRs when includeDrafts is true", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/issues") return { data: [], headers: {} };
			if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [unlabeledPr, draftPr], headers: {} };
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportUnlabeled(octokit, { owner: "cldmv", repo: "r", target: "pulls", includeDrafts: true });
		expect(out.unlabeled.map((u) => u.number)).toEqual([4, 5]);
	});

	it("enumerates org repos and skips archived ones when repo is omitted", async () => {
		const octokit = octokitWith(async (route, params) => {
			if (route === "GET /orgs/{owner}/repos") {
				expect(params.owner).toBe("cldmv");
				return { data: [{ name: "a" }, { name: "b", archived: true }, { name: "c" }], headers: {} };
			}
			if (route === "GET /repos/{owner}/{repo}/issues") return { data: [], headers: {} };
			if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [], headers: {} };
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportUnlabeled(octokit, { owner: "cldmv" });
		expect(out.scanned.repos).toBe(2);
	});

	it("falls back to the user-repos endpoint when the org endpoint 404s", async () => {
		const octokit = octokitWith(async (route, params) => {
			if (route === "GET /orgs/{owner}/repos") {
				const err = Object.assign(new Error("Not Found"), { status: 404 });
				throw err;
			}
			if (route === "GET /users/{username}/repos") {
				expect(params.username).toBe("someuser");
				return { data: [{ name: "solo" }], headers: {} };
			}
			if (route === "GET /repos/{owner}/{repo}/issues") return { data: [], headers: {} };
			if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [], headers: {} };
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportUnlabeled(octokit, { owner: "someuser" });
		expect(out.scanned.repos).toBe(1);
	});

	it("caps results at perRepoLimit even when more items come back in one page", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/issues") return { data: [unlabeledIssue, { ...unlabeledIssue, number: 20 }], headers: {} };
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportUnlabeled(octokit, { owner: "cldmv", repo: "r", target: "issues", perRepoLimit: 1 });
		expect(out.scanned.issues).toBe(1);
		expect(out.unlabeled).toHaveLength(1);
	});

	it("stops and reports truncated when remaining drops at/below 2% of the token's own limit (5000/hr PAT)", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/issues") {
				return { data: [unlabeledIssue], headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "50" } };
			}
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportUnlabeled(octokit, { owner: "cldmv", repo: "r", target: "issues" });
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("rate-limited");
		expect(out.retryAfterSeconds).toBeUndefined();
		expect(out.unlabeled).toEqual([]);
	});

	it("does NOT stop when remaining is comfortably above 2% of a 5000/hr limit", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/issues") {
				return { data: [unlabeledIssue], headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4800" } };
			}
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportUnlabeled(octokit, { owner: "cldmv", repo: "r", target: "issues" });
		expect(out.truncated).toBeUndefined();
		expect(out.unlabeled).toHaveLength(1);
	});

	it("uses the absolute floor for a low-limit token (e.g. unauthenticated, 60/hr) instead of a near-zero ratio", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/issues") {
				// 2% of 60 is ~1, but the absolute floor (20) takes over — 15 remaining still trips it.
				return { data: [unlabeledIssue], headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "15" } };
			}
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportUnlabeled(octokit, { owner: "cldmv", repo: "r", target: "issues" });
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("rate-limited");
	});

	it("falls back to the absolute floor when x-ratelimit-limit is missing", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/issues") return { data: [unlabeledIssue], headers: { "x-ratelimit-remaining": "10" } };
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportUnlabeled(octokit, { owner: "cldmv", repo: "r", target: "issues" });
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("rate-limited");
	});

	it("stops and reports truncated with retryAfterSeconds on a 403", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/issues") {
				throw Object.assign(new Error("rate limited"), { status: 403, response: { headers: { "retry-after": "30" } } });
			}
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportUnlabeled(octokit, { owner: "cldmv", repo: "r", target: "issues" });
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("rate-limited");
		expect(out.retryAfterSeconds).toBe(30);
	});

	it("stops on a 403 with no Retry-After header and omits retryAfterSeconds", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/issues") throw Object.assign(new Error("rate limited"), { status: 403 });
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportUnlabeled(octokit, { owner: "cldmv", repo: "r", target: "issues" });
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("rate-limited");
		expect(out.retryAfterSeconds).toBeUndefined();
	});

	it("stops on a rate limit hit during repo enumeration without falling back to the user endpoint", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /orgs/{owner}/repos") throw Object.assign(new Error("rate limited"), { status: 429 });
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportUnlabeled(octokit, { owner: "cldmv" });
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("rate-limited");
		expect(octokit.request).not.toHaveBeenCalledWith("GET /users/{username}/repos", expect.anything());
	});

	it("propagates a non-404 error during repo enumeration without falling back to the user endpoint", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /orgs/{owner}/repos") throw Object.assign(new Error("server exploded"), { status: 500 });
			throw new Error(`unexpected route ${route}`);
		});
		await expect(reportUnlabeled(octokit, { owner: "cldmv" })).rejects.toThrow(/server exploded/);
		expect(octokit.request).not.toHaveBeenCalledWith("GET /users/{username}/repos", expect.anything());
	});

	it("stops and reports truncated reason max-api-calls when the call budget is exhausted", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/issues") return { data: [], headers: {} };
			if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [], headers: {} };
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportUnlabeled(octokit, { owner: "cldmv", repo: "r", target: "both", maxApiCalls: 1 });
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("max-api-calls");
	});

	it("advances to a second page when a page comes back exactly full", async () => {
		const fullPage = Array.from({ length: 100 }, (_, i) => ({ name: `repo${i}` }));
		const octokit = octokitWith(async (route, params) => {
			if (route === "GET /orgs/{owner}/repos") return params.page === 2 ? { data: [{ name: "last" }], headers: {} } : { data: fullPage, headers: {} };
			if (route === "GET /repos/{owner}/{repo}/issues") return { data: [], headers: {} };
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportUnlabeled(octokit, { owner: "cldmv", target: "issues", maxRepos: 150 });
		expect(out.scanned.repos).toBe(101);
	});

	it("re-throws an error that is neither a rate limit nor a budget exhaustion", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/issues") throw new Error("boom");
			throw new Error(`unexpected route ${route}`);
		});
		await expect(reportUnlabeled(octokit, { owner: "cldmv", repo: "r", target: "issues" })).rejects.toThrow(/boom/);
	});

	it("advertises a valid schema", () => {
		expect(REPORT_UNLABELED_SCHEMA.required).toEqual(["owner"]);
		expect(REPORT_UNLABELED_SCHEMA.additionalProperties).toBe(false);
	});
});

describe("reportCiStatus", () => {
	function octokitWith(handler: (route: string, params: any) => Promise<{ data: unknown; headers?: Record<string, string> }>): any {
		return { request: vi.fn(handler) };
	}
	const pr = (sha: string) => ({ data: { head: { sha } } });
	const runs = (workflow_runs: unknown[]) => ({ data: { workflow_runs }, headers: {} });
	const jobs = (jobs_: unknown[]) => ({ data: { jobs: jobs_ }, headers: {} });
	const run = (over: Partial<{ id: number; name: string; status: string; conclusion: string | null; html_url: string }> = {}) => ({
		id: 1,
		name: "CI",
		status: "completed",
		conclusion: "success",
		html_url: "https://gh/run/1",
		...over
	});
	const job = (over: Partial<{ id: number; name: string; status: string; conclusion: string | null; html_url: string; steps: unknown[] }> = {}) => ({
		id: 100,
		name: "test",
		status: "completed",
		conclusion: "success",
		html_url: "https://gh/job/100",
		steps: [],
		...over
	});
	const step = (over: Partial<{ name: string; status: string; conclusion: string | null; number: number; started_at: string | null; completed_at: string | null }> = {}) => ({
		name: "npm test",
		status: "completed",
		conclusion: "success",
		number: 1,
		started_at: "2026-01-01T00:00:00Z",
		completed_at: "2026-01-01T00:00:05Z",
		...over
	});

	it("tier 0: counts passed/failed/pending, no failures key, no job calls made", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pr("sha1");
			if (route === "GET /repos/{owner}/{repo}/actions/runs") {
				return runs([run({ id: 1, conclusion: "success" }), run({ id: 2, conclusion: "failure" }), run({ id: 3, status: "in_progress", conclusion: null })]);
			}
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportCiStatus(octokit, { owner: "cldmv", repo: "r", pull: 5 });
		expect(out).toEqual({ pull: 5, summary: { passed: 1, failed: 1, pending: 1 } });
		expect(octokit.request).not.toHaveBeenCalledWith("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", expect.anything());
	});

	it("tier 1: includes only the failing job of a failing run, with workflow/job/run info", async () => {
		const octokit = octokitWith(async (route, params) => {
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pr("sha1");
			if (route === "GET /repos/{owner}/{repo}/actions/runs") return runs([run({ id: 9, name: "CI", conclusion: "failure" })]);
			if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs") {
				expect(params.run_id).toBe(9);
				return jobs([job({ id: 200, name: "lint", conclusion: "success" }), job({ id: 201, name: "test", conclusion: "failure" })]);
			}
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportCiStatus(octokit, { owner: "cldmv", repo: "r", pull: 5, verbosity: 1 });
		expect(out.summary).toEqual({ passed: 0, failed: 1, pending: 0 });
		expect(out.failures).toEqual([{ workflow: "CI", job: "test", runId: 9, runUrl: "https://gh/run/1", conclusion: "failure" }]);
	});

	it("tier 2: attaches only the failing steps of a failing job, with computed durationMs", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pr("sha1");
			if (route === "GET /repos/{owner}/{repo}/actions/runs") return runs([run({ conclusion: "failure" })]);
			if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs") {
				return jobs([
					job({
						conclusion: "failure",
						steps: [step({ name: "setup", conclusion: "success" }), step({ name: "npm run coverage", number: 4, conclusion: "failure", started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:00:08.213Z" })]
					})
				]);
			}
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportCiStatus(octokit, { owner: "cldmv", repo: "r", pull: 5, verbosity: 2 });
		expect(out.failures?.[0]?.steps).toEqual([{ name: "npm run coverage", number: 4, conclusion: "failure", durationMs: 8213 }]);
	});

	it("tier 3: attaches the failing job's log via the injected fetchFailedJobLogs, one call per failing run", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pr("sha1");
			if (route === "GET /repos/{owner}/{repo}/actions/runs") return runs([run({ id: 9, conclusion: "failure" })]);
			if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs") return jobs([job({ id: 555, conclusion: "failure" }), job({ id: 556, conclusion: "success" })]);
			throw new Error(`unexpected route ${route}`);
		});
		const fetchFailedJobLogs = vi.fn(async (runId: number, tailLines: number) => {
			expect(runId).toBe(9);
			expect(tailLines).toBe(5);
			return new Map([[555, "tailed log content"]]);
		});
		const out = await reportCiStatus(octokit, { owner: "cldmv", repo: "r", pull: 5, verbosity: 3, logLines: 5 }, fetchFailedJobLogs);
		expect(fetchFailedJobLogs).toHaveBeenCalledTimes(1); // once per failing RUN, not per job
		expect(out.failures?.[0]?.logTail).toBe("tailed log content");
	});

	it("tier 3: leaves logTail unset for a job with no entry in the fetched map", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pr("sha1");
			if (route === "GET /repos/{owner}/{repo}/actions/runs") return runs([run({ conclusion: "failure" })]);
			if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs") return jobs([job({ id: 555, conclusion: "failure" })]);
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportCiStatus(octokit, { owner: "cldmv", repo: "r", pull: 5, verbosity: 3 }, async () => new Map());
		expect(out.failures?.[0]?.logTail).toBeUndefined();
	});

	it("tier 3: skips fetching logs entirely when no fetcher is provided", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pr("sha1");
			if (route === "GET /repos/{owner}/{repo}/actions/runs") return runs([run({ conclusion: "failure" })]);
			if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs") return jobs([job({ id: 555, conclusion: "failure" })]);
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportCiStatus(octokit, { owner: "cldmv", repo: "r", pull: 5, verbosity: 3 });
		expect(out.failures?.[0]?.logTail).toBeUndefined();
	});

	it("scans every open PR when pull is omitted, including only PRs with a failure", async () => {
		const octokit = octokitWith(async (route, params) => {
			if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [{ number: 1, head: { sha: "a" } }, { number: 2, head: { sha: "b" } }], headers: {} };
			if (route === "GET /repos/{owner}/{repo}/actions/runs") {
				return runs(params.head_sha === "a" ? [run({ conclusion: "success" })] : [run({ conclusion: "failure" })]);
			}
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportCiStatus(octokit, { owner: "cldmv", repo: "r" });
		expect(out).toEqual({ scanned: { pulls: 2 }, results: [{ pull: 2, summary: { passed: 0, failed: 1, pending: 0 } }] });
	});

	it("flags truncated:max-pulls when the open-PR list is exactly at the cap", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [{ number: 1, head: { sha: "a" } }, { number: 2, head: { sha: "b" } }], headers: {} };
			if (route === "GET /repos/{owner}/{repo}/actions/runs") return runs([run({ conclusion: "success" })]);
			throw new Error(`unexpected route ${route}`);
		});
		const out = (await reportCiStatus(octokit, { owner: "cldmv", repo: "r", maxPulls: 2 })) as any;
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("max-pulls");
	});

	it("stops mid-scan on a rate limit with no failures collected yet, single-pull mode", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pr("sha1");
			if (route === "GET /repos/{owner}/{repo}/actions/runs") return runs([run({ id: 1, conclusion: "failure" }), run({ id: 2, conclusion: "failure" })]);
			if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs") {
				throw Object.assign(new Error("rate limited"), { status: 403 });
			}
			throw new Error(`unexpected route ${route}`);
		});
		const out = (await reportCiStatus(octokit, { owner: "cldmv", repo: "r", pull: 5, verbosity: 1 })) as any;
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("rate-limited");
		expect(out.summary.failed).toBe(2);
		expect(out.failures).toBeUndefined();
	});

	it("stops mid-scan on a rate limit but preserves failures already collected from an earlier run", async () => {
		const octokit = octokitWith(async (route, params) => {
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pr("sha1");
			if (route === "GET /repos/{owner}/{repo}/actions/runs") return runs([run({ id: 1, conclusion: "failure" }), run({ id: 2, conclusion: "failure" })]);
			if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs") {
				if (params.run_id === 1) return jobs([job({ id: 201, name: "test", conclusion: "failure" })]);
				throw Object.assign(new Error("rate limited"), { status: 403 });
			}
			throw new Error(`unexpected route ${route}`);
		});
		const out = (await reportCiStatus(octokit, { owner: "cldmv", repo: "r", pull: 5, verbosity: 1 })) as any;
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("rate-limited");
		expect(out.failures).toEqual([{ workflow: "CI", job: "test", runId: 1, runUrl: "https://gh/run/1", conclusion: "failure" }]);
	});

	it("reports 'unknown' for a null job/step conclusion, and defaults to no steps when a job has none listed", async () => {
		const jobNoSteps = job({ conclusion: null });
		delete (jobNoSteps as any).steps;
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pr("sha1");
			if (route === "GET /repos/{owner}/{repo}/actions/runs") return runs([run({ conclusion: "failure" })]);
			if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs") return jobs([jobNoSteps]);
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportCiStatus(octokit, { owner: "cldmv", repo: "r", pull: 5, verbosity: 2 });
		expect(out.failures).toEqual([{ workflow: "CI", job: "test", runId: 1, runUrl: "https://gh/run/1", conclusion: "unknown", steps: [] }]);
	});

	it("reports a null step conclusion as 'unknown' and a 0ms duration when timestamps are missing", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pr("sha1");
			if (route === "GET /repos/{owner}/{repo}/actions/runs") return runs([run({ conclusion: "failure" })]);
			if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs") {
				return jobs([job({ conclusion: "failure", steps: [step({ conclusion: null, started_at: null, completed_at: null })] })]);
			}
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportCiStatus(octokit, { owner: "cldmv", repo: "r", pull: 5, verbosity: 2 });
		expect(out.failures?.[0]?.steps).toEqual([{ name: "npm test", number: 1, conclusion: "unknown", durationMs: 0 }]);
	});

	it("surfaces retryAfterSeconds on a single-pull rate limit that includes a Retry-After header", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") throw Object.assign(new Error("nope"), { status: 429, response: { headers: { "retry-after": "45" } } });
			throw new Error(`unexpected route ${route}`);
		});
		const out = (await reportCiStatus(octokit, { owner: "cldmv", repo: "r", pull: 5 })) as any;
		expect(out.retryAfterSeconds).toBe(45);
	});

	it("surfaces retryAfterSeconds on a multi-pull rate limit that includes a Retry-After header", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [{ number: 1, head: { sha: "a" } }], headers: {} };
			if (route === "GET /repos/{owner}/{repo}/actions/runs") throw Object.assign(new Error("nope"), { status: 429, response: { headers: { "retry-after": "12" } } });
			throw new Error(`unexpected route ${route}`);
		});
		const out = (await reportCiStatus(octokit, { owner: "cldmv", repo: "r" })) as any;
		expect(out.retryAfterSeconds).toBe(12);
	});

	it("stops the whole multi-pull scan (not just one PR) when a PR's scan hits the call budget", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [{ number: 1, head: { sha: "a" } }, { number: 2, head: { sha: "b" } }], headers: {} };
			if (route === "GET /repos/{owner}/{repo}/actions/runs") return runs([run({ conclusion: "success" })]);
			throw new Error(`unexpected route ${route}`);
		});
		const out = (await reportCiStatus(octokit, { owner: "cldmv", repo: "r", maxApiCalls: 2 })) as any;
		// pulls-list call (1) + PR#1's runs call (2) exhaust the budget before PR#2 is ever scanned.
		expect(octokit.request).toHaveBeenCalledTimes(2);
		expect(out.scanned.pulls).toBe(1);
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("max-api-calls");
	});

	it("returns a truncated result immediately when the PR lookup itself is rate-limited", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") throw Object.assign(new Error("nope"), { status: 429 });
			throw new Error(`unexpected route ${route}`);
		});
		const out = (await reportCiStatus(octokit, { owner: "cldmv", repo: "r", pull: 5 })) as any;
		expect(out).toMatchObject({ pull: 5, summary: { passed: 0, failed: 0, pending: 0 }, truncated: true, truncatedReason: "rate-limited" });
	});

	it("returns an empty truncated result when the open-PR list itself is rate-limited", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls") throw Object.assign(new Error("nope"), { status: 429 });
			throw new Error(`unexpected route ${route}`);
		});
		const out = (await reportCiStatus(octokit, { owner: "cldmv", repo: "r" })) as any;
		expect(out).toMatchObject({ scanned: { pulls: 0 }, results: [], truncated: true, truncatedReason: "rate-limited" });
	});

	it("re-throws a genuine error (not a rate limit) from the PR lookup", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") throw Object.assign(new Error("not found"), { status: 404 });
			throw new Error(`unexpected route ${route}`);
		});
		await expect(reportCiStatus(octokit, { owner: "cldmv", repo: "r", pull: 5 })).rejects.toThrow(/not found/);
	});

	it("re-throws a genuine error (not a rate limit) from inside a single PR's scan", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pr("sha1");
			if (route === "GET /repos/{owner}/{repo}/actions/runs") throw Object.assign(new Error("server exploded"), { status: 500 });
			throw new Error(`unexpected route ${route}`);
		});
		await expect(reportCiStatus(octokit, { owner: "cldmv", repo: "r", pull: 5 })).rejects.toThrow(/server exploded/);
	});

	it("re-throws a genuine error (not a rate limit) from the open-PR list", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls") throw Object.assign(new Error("server exploded"), { status: 500 });
			throw new Error(`unexpected route ${route}`);
		});
		await expect(reportCiStatus(octokit, { owner: "cldmv", repo: "r" })).rejects.toThrow(/server exploded/);
	});

	it("clamps an out-of-range verbosity into 0-3", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pr("sha1");
			if (route === "GET /repos/{owner}/{repo}/actions/runs") return runs([run({ conclusion: "failure" })]);
			if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs") return jobs([job({ id: 555, conclusion: "failure" })]);
			throw new Error(`unexpected route ${route}`);
		});
		// verbosity: 99 clamps to 3 (not silently dropped to 0) — proven by the log fetch actually happening.
		const out = await reportCiStatus(octokit, { owner: "cldmv", repo: "r", pull: 5, verbosity: 99 as any }, async () => new Map([[555, "log"]]));
		expect(out.failures?.[0]?.logTail).toBe("log");
	});

	it("advertises a valid schema", () => {
		expect(REPORT_CI_STATUS_SCHEMA.required).toEqual(["owner", "repo"]);
		expect(REPORT_CI_STATUS_SCHEMA.additionalProperties).toBe(false);
	});
});
