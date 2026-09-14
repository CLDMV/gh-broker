import { describe, it, expect, vi, beforeEach } from "vitest";
import { linkIssue, LINK_ISSUE_SCHEMA } from "../src/verbs/link_issue.ts";
import {
	resolveReviewThread,
	replyReviewThread,
	RESOLVE_REVIEW_THREAD_SCHEMA,
	REPLY_REVIEW_THREAD_SCHEMA
} from "../src/verbs/review_thread.ts";
import { reportUnlabeled, REPORT_UNLABELED_SCHEMA } from "../src/verbs/report_unlabeled.ts";

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
