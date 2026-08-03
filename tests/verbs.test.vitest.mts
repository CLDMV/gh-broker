import { describe, it, expect, vi, beforeEach } from "vitest";
import { linkIssue, LINK_ISSUE_SCHEMA } from "../src/verbs/link_issue.ts";
import {
	resolveReviewThread,
	replyReviewThread,
	RESOLVE_REVIEW_THREAD_SCHEMA,
	REPLY_REVIEW_THREAD_SCHEMA
} from "../src/verbs/review_thread.ts";

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
