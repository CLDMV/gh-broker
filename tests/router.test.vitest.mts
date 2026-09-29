import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Octokit is `new`-ed inside dispatchCustom for the review-thread verbs, so mock it
// to hand back a controllable graphql fn. link_issue instead uses the injected
// appAuth's octokit (also wired to graphqlMock below).
const { graphqlMock, requestMock } = vi.hoisted(() => ({ graphqlMock: vi.fn(), requestMock: vi.fn() }));
vi.mock("@octokit/core", () => ({
	// Constructable mock (arrow fns can't be `new`-ed) — every instance shares graphqlMock/requestMock.
	Octokit: vi.fn(function (this: any) {
		this.graphql = graphqlMock;
		this.request = requestMock;
	})
}));

import { Octokit } from "@octokit/core";
import { Router, extractOwner } from "../src/router.ts";

function makeConfig(overrides: Record<string, unknown> = {}): any {
	return {
		listen: "unix:/x.sock",
		upstream: "https://api.githubcopilot.com/mcp/",
		tools: [
			{ name: "get_me", mode: "read" },
			{ name: "create_pull_request", mode: "write" },
			{ name: "link_issue", mode: "write", custom: true },
			{ name: "resolve_review_thread", mode: "write", custom: true },
			{ name: "reply_review_thread", mode: "write", custom: true },
			{ name: "report_unlabeled", mode: "read", custom: true },
			{ name: "report_ci_status", mode: "read", custom: true },
			{ name: "pull_request_read", mode: "read", augment: true }
		],
		owners: { cldmv: { read: "cred:cldmv-read", write: "cred:cldmv-write" } },
		...overrides
	};
}

describe("extractOwner", () => {
	it("reads args.owner (lowercased)", () => {
		expect(extractOwner({ owner: "CLDMV" })).toBe("cldmv");
	});
	it("falls back to args.org for org-scoped tools", () => {
		expect(extractOwner({ org: "SomeOrg" })).toBe("someorg");
	});
	it("extracts repo:owner/name out of a search query", () => {
		expect(extractOwner({ query: "is:pr repo:CLDMV/gh-broker author:x" })).toBe("cldmv");
	});
	it("extracts org: out of a search query", () => {
		expect(extractOwner({ query: "org:Acme is:issue" })).toBe("acme");
	});
	it("extracts user: out of a search query", () => {
		expect(extractOwner({ query: "user:Someone foo" })).toBe("someone");
	});
	it("reads the owner from a repository owner/name string", () => {
		expect(extractOwner({ repository: "CLDMV/thing" })).toBe("cldmv");
	});
	it("returns undefined when no owner is derivable", () => {
		expect(extractOwner({ foo: "bar" })).toBeUndefined();
		expect(extractOwner({ repository: "no-slash" })).toBeUndefined();
		expect(extractOwner({ query: "just some words" })).toBeUndefined();
	});
});

describe("Router.call", () => {
	let secrets: { resolve: ReturnType<typeof vi.fn> };
	let upstream: { forward: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {}); // silence audit output
		secrets = { resolve: vi.fn((ref: string) => `token:${ref}`) };
		upstream = { forward: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }) };
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("denies a tool that is not in the allowlist", async () => {
		const r = new Router(makeConfig(), secrets as any, upstream as any);
		await expect(r.call("rm_rf", {})).rejects.toThrow(/tool "rm_rf" is not allowed/);
		expect(upstream.forward).not.toHaveBeenCalled();
	});

	it("advertisedTools returns the config tools", () => {
		const cfg = makeConfig();
		const r = new Router(cfg, secrets as any, upstream as any);
		expect(r.advertisedTools()).toBe(cfg.tools);
	});

	it("forwards a read call with the resolved read PAT", async () => {
		const r = new Router(makeConfig(), secrets as any, upstream as any);
		const out = await r.call("get_me", { owner: "CLDMV" });
		expect(secrets.resolve).toHaveBeenCalledWith("cred:cldmv-read");
		expect(upstream.forward).toHaveBeenCalledWith("get_me", { owner: "CLDMV" }, "token:cred:cldmv-read");
		expect(out).toEqual({ content: [{ type: "text", text: "ok" }] });
	});

	it("uses the write PAT for a write-mode tool", async () => {
		const r = new Router(makeConfig(), secrets as any, upstream as any);
		await r.call("create_pull_request", { owner: "cldmv", repo: "gh-broker" });
		expect(secrets.resolve).toHaveBeenCalledWith("cred:cldmv-write");
	});

	it("falls back an owner-less READ to defaultOwner's read PAT", async () => {
		const r = new Router(makeConfig({ defaultOwner: "cldmv" }), secrets as any, upstream as any);
		await r.call("get_me", {});
		expect(secrets.resolve).toHaveBeenCalledWith("cred:cldmv-read");
		expect(upstream.forward).toHaveBeenCalledWith("get_me", {}, "token:cred:cldmv-read");
	});

	it("does NOT fall back an owner-less WRITE, even with defaultOwner set", async () => {
		const r = new Router(makeConfig({ defaultOwner: "cldmv" }), secrets as any, upstream as any);
		await expect(r.call("create_pull_request", {})).rejects.toThrow(/could not determine repo owner/);
	});

	it("errors on an owner-less read when there is no defaultOwner", async () => {
		const r = new Router(makeConfig(), secrets as any, upstream as any);
		await expect(r.call("get_me", {})).rejects.toThrow(/could not determine repo owner/);
	});

	it("errors when the owner has no configured credentials", async () => {
		const r = new Router(makeConfig(), secrets as any, upstream as any);
		await expect(r.call("get_me", { owner: "stranger" })).rejects.toThrow(/no credentials configured for owner "stranger"/);
	});

	it("re-throws (and audits) when the upstream forward fails", async () => {
		upstream.forward.mockRejectedValue(new Error("upstream boom"));
		const r = new Router(makeConfig(), secrets as any, upstream as any);
		await expect(r.call("get_me", { owner: "cldmv" })).rejects.toThrow(/upstream boom/);
	});

	describe("custom verbs", () => {
		it("link_issue is DEFERRED — dispatching it (even if allowlisted) is not implemented", async () => {
			// The catalog + router hooks for link_issue are commented out (App-token-only,
			// not wired in). So even with an allowlist entry it never dispatches — it falls
			// through to the not-implemented default, and never reaches the upstream.
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			await expect(r.call("link_issue", { owner: "cldmv", repo: "x", pull: 1, issue: 2 })).rejects.toThrow(
				/custom verb "link_issue" not implemented/
			);
			expect(upstream.forward).not.toHaveBeenCalled();
		});

		it("resolve_review_thread runs on a write-PAT Octokit", async () => {
			graphqlMock.mockResolvedValue({ resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } });
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out = await r.call("resolve_review_thread", { owner: "cldmv", threadId: "PRRT_1" });
			expect(Octokit).toHaveBeenCalledWith({ auth: "token:cred:cldmv-write" });
			expect(out).toEqual({ content: [{ type: "text", text: "thread PRRT_1: isResolved=true" }] });
		});

		it("throws for an allowlisted custom verb that has no implementation", async () => {
			const cfg = makeConfig({ tools: [{ name: "weird_verb", mode: "read", custom: true }] });
			const r = new Router(cfg, secrets as any, upstream as any);
			await expect(r.call("weird_verb", { owner: "cldmv" })).rejects.toThrow(/custom verb "weird_verb" not implemented/);
		});

		it("reply_review_thread runs on a write-PAT Octokit", async () => {
			graphqlMock.mockResolvedValue({ addPullRequestReviewThreadReply: { comment: { id: "C_1", url: "https://gh/c/1" } } });
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out = await r.call("reply_review_thread", { owner: "cldmv", threadId: "PRRT_1", body: "thanks" });
			expect(out).toEqual({ content: [{ type: "text", text: "replied: https://gh/c/1" }] });
		});

		it("report_unlabeled runs on a read-PAT Octokit and returns the JSON report as text", async () => {
			requestMock.mockResolvedValue({ data: [], headers: {} });
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out = await r.call("report_unlabeled", { owner: "cldmv", repo: "gh-broker" });
			expect(Octokit).toHaveBeenCalledWith({ auth: "token:cred:cldmv-read" });
			expect(out).toEqual({
				content: [{ type: "text", text: JSON.stringify({ scanned: { repos: 1, issues: 0, pulls: 0 }, unlabeled: [] }) }]
			});
		});

		it("report_ci_status runs on a read-PAT Octokit and returns the JSON report as text", async () => {
			requestMock.mockResolvedValueOnce({ data: { head: { sha: "abc" } }, headers: {} }).mockResolvedValueOnce({ data: { workflow_runs: [] }, headers: {} });
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out = await r.call("report_ci_status", { owner: "cldmv", repo: "gh-broker", pull: 5 });
			expect(Octokit).toHaveBeenCalledWith({ auth: "token:cred:cldmv-read" });
			expect(out).toEqual({
				content: [{ type: "text", text: JSON.stringify({ pull: 5, summary: { passed: 0, failed: 0, pending: 0 } }) }]
			});
		});

		describe("report_ci_status tier-3 log fetch (via get_job_logs, not raw REST)", () => {
			const queuePrRunJob = () =>
				requestMock
					.mockResolvedValueOnce({ data: { head: { sha: "abc" } }, headers: {} })
					.mockResolvedValueOnce({ data: { workflow_runs: [{ id: 9, name: "CI", status: "completed", conclusion: "failure", html_url: "https://gh/run/9" }] }, headers: {} })
					.mockResolvedValueOnce({ data: { jobs: [{ id: 555, name: "test", status: "completed", conclusion: "failure", html_url: "https://gh/job/555", steps: [] }] }, headers: {} });

			it("calls get_job_logs with failed_only+run_id and attaches the matched job's log", async () => {
				queuePrRunJob();
				upstream.forward.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ logs: [{ job_id: 555, logs_content: "boom" }] }) }] });
				const r = new Router(makeConfig(), secrets as any, upstream as any);
				const out: any = await r.call("report_ci_status", { owner: "cldmv", repo: "gh-broker", pull: 5, verbosity: 3 });
				expect(upstream.forward).toHaveBeenCalledWith(
					"get_job_logs",
					{ owner: "cldmv", repo: "gh-broker", run_id: 9, failed_only: true, return_content: true, tail_lines: 200 },
					"token:cred:cldmv-read"
				);
				expect(JSON.parse(out.content[0].text).failures[0].logTail).toBe("boom");
			});

			it("yields no logTail when get_job_logs' content isn't the expected JSON-text shape", async () => {
				queuePrRunJob();
				upstream.forward.mockResolvedValue({ content: [{ type: "text", text: "not json" }] });
				const r = new Router(makeConfig(), secrets as any, upstream as any);
				const out: any = await r.call("report_ci_status", { owner: "cldmv", repo: "gh-broker", pull: 5, verbosity: 3 });
				expect(JSON.parse(out.content[0].text).failures[0].logTail).toBeUndefined();
			});

			it("yields no logTail when get_job_logs has no text content block at all", async () => {
				queuePrRunJob();
				upstream.forward.mockResolvedValue({ content: [] });
				const r = new Router(makeConfig(), secrets as any, upstream as any);
				const out: any = await r.call("report_ci_status", { owner: "cldmv", repo: "gh-broker", pull: 5, verbosity: 3 });
				expect(JSON.parse(out.content[0].text).failures[0].logTail).toBeUndefined();
			});

			it("yields no logTail when get_job_logs itself throws (best-effort, not a hard failure)", async () => {
				queuePrRunJob();
				upstream.forward.mockRejectedValue(new Error("upstream boom"));
				const r = new Router(makeConfig(), secrets as any, upstream as any);
				const out: any = await r.call("report_ci_status", { owner: "cldmv", repo: "gh-broker", pull: 5, verbosity: 3 });
				expect(JSON.parse(out.content[0].text).failures[0].logTail).toBeUndefined();
			});

			it("yields no logTail when the parsed response has no logs array at all", async () => {
				queuePrRunJob();
				upstream.forward.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ message: "no failed jobs" }) }] });
				const r = new Router(makeConfig(), secrets as any, upstream as any);
				const out: any = await r.call("report_ci_status", { owner: "cldmv", repo: "gh-broker", pull: 5, verbosity: 3 });
				expect(JSON.parse(out.content[0].text).failures[0].logTail).toBeUndefined();
			});

			it("ignores a logs entry with a malformed job_id/logs_content", async () => {
				queuePrRunJob();
				upstream.forward.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ logs: [{ job_id: "not-a-number", logs_content: "x" }] }) }] });
				const r = new Router(makeConfig(), secrets as any, upstream as any);
				const out: any = await r.call("report_ci_status", { owner: "cldmv", repo: "gh-broker", pull: 5, verbosity: 3 });
				expect(JSON.parse(out.content[0].text).failures[0].logTail).toBeUndefined();
			});
		});
	});

	describe("augmented tools", () => {
		it("forwards untouched when ciVerbosity is absent (opt-in only)", async () => {
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out = await r.call("pull_request_read", { owner: "cldmv", repo: "gh-broker", pullNumber: 5, method: "get" });
			expect(out).toEqual({ content: [{ type: "text", text: "ok" }] });
			expect(Octokit).not.toHaveBeenCalled();
		});

		it("forwards untouched when method isn't get, even with ciVerbosity present", async () => {
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out = await r.call("pull_request_read", { owner: "cldmv", repo: "gh-broker", pullNumber: 5, method: "get_diff", ciVerbosity: 1 });
			expect(out).toEqual({ content: [{ type: "text", text: "ok" }] });
			expect(upstream.forward).toHaveBeenCalledWith("pull_request_read", { owner: "cldmv", repo: "gh-broker", pullNumber: 5, method: "get_diff" }, "token:cred:cldmv-read");
		});

		it("injects a ci field computed from the PR's head sha when ciVerbosity is given", async () => {
			upstream.forward.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ number: 5, head: { sha: "abc123" } }) }] });
			requestMock.mockResolvedValueOnce({ data: { workflow_runs: [] }, headers: {} });
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out = await r.call("pull_request_read", { owner: "cldmv", repo: "gh-broker", pullNumber: 5, method: "get", ciVerbosity: 0 });
			expect(Octokit).toHaveBeenCalledWith({ auth: "token:cred:cldmv-read" });
			// Strips gh-broker's own params before forwarding upstream.
			expect(upstream.forward).toHaveBeenCalledWith("pull_request_read", { owner: "cldmv", repo: "gh-broker", pullNumber: 5, method: "get" }, "token:cred:cldmv-read");
			expect(out).toEqual({
				content: [{ type: "text", text: JSON.stringify({ number: 5, head: { sha: "abc123" }, ci: { pull: 5, summary: { passed: 0, failed: 0, pending: 0 } } }) }]
			});
		});

		it("tier 3 on the augmented pull_request_read also fetches logs via get_job_logs", async () => {
			upstream.forward.mockImplementation(async (tool: string) => {
				if (tool === "pull_request_read") return { content: [{ type: "text", text: JSON.stringify({ number: 5, head: { sha: "abc123" } }) }] };
				if (tool === "get_job_logs") return { content: [{ type: "text", text: JSON.stringify({ logs: [{ job_id: 555, logs_content: "boom" }] }) }] };
				throw new Error(`unexpected upstream tool ${tool}`);
			});
			requestMock
				.mockResolvedValueOnce({ data: { workflow_runs: [{ id: 9, name: "CI", status: "completed", conclusion: "failure", html_url: "https://gh/run/9" }] }, headers: {} })
				.mockResolvedValueOnce({ data: { jobs: [{ id: 555, name: "test", status: "completed", conclusion: "failure", html_url: "https://gh/job/555", steps: [] }] }, headers: {} });
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out: any = await r.call("pull_request_read", { owner: "cldmv", repo: "gh-broker", pullNumber: 5, method: "get", ciVerbosity: 3 });
			expect(upstream.forward).toHaveBeenCalledWith(
				"get_job_logs",
				{ owner: "cldmv", repo: "gh-broker", run_id: 9, failed_only: true, return_content: true, tail_lines: 200 },
				"token:cred:cldmv-read"
			);
			expect(JSON.parse(out.content[0].text).ci.failures[0].logTail).toBe("boom");
		});

		it("defaults to method 'get' (augments) when method is omitted entirely, and forwards a given logLines", async () => {
			upstream.forward.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ number: 5, head: { sha: "abc123" } }) }] });
			requestMock.mockResolvedValueOnce({ data: { workflow_runs: [] }, headers: {} });
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out: any = await r.call("pull_request_read", { owner: "cldmv", repo: "gh-broker", pullNumber: 5, ciVerbosity: 0, logLines: 50 });
			expect(JSON.parse(out.content[0].text).ci).toEqual({ pull: 5, summary: { passed: 0, failed: 0, pending: 0 } });
		});

		it("returns the upstream result untouched when there is no text content block at all", async () => {
			upstream.forward.mockResolvedValue({ content: [] });
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out = await r.call("pull_request_read", { owner: "cldmv", repo: "gh-broker", pullNumber: 5, method: "get", ciVerbosity: 0 });
			expect(out).toEqual({ content: [] });
			expect(Octokit).not.toHaveBeenCalled();
		});

		it("resolves a missing repo arg to an empty string rather than throwing", async () => {
			upstream.forward.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ number: 5, head: { sha: "abc123" } }) }] });
			requestMock.mockResolvedValueOnce({ data: { workflow_runs: [] }, headers: {} });
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out: any = await r.call("pull_request_read", { owner: "cldmv", pullNumber: 5, method: "get", ciVerbosity: 0 });
			expect(JSON.parse(out.content[0].text).ci).toEqual({ pull: 5, summary: { passed: 0, failed: 0, pending: 0 } });
		});

		it("returns the upstream result untouched when its content isn't the expected JSON-text shape", async () => {
			upstream.forward.mockResolvedValue({ content: [{ type: "text", text: "not json" }] });
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out = await r.call("pull_request_read", { owner: "cldmv", repo: "gh-broker", pullNumber: 5, method: "get", ciVerbosity: 0 });
			expect(out).toEqual({ content: [{ type: "text", text: "not json" }] });
			expect(Octokit).not.toHaveBeenCalled();
		});

		it("just forwards an augment-flagged tool with no dispatchAugmented case for it", async () => {
			const cfg = makeConfig({ tools: [{ name: "weird_augment", mode: "read", augment: true }] });
			const r = new Router(cfg, secrets as any, upstream as any);
			const out = await r.call("weird_augment", { owner: "cldmv" });
			expect(out).toEqual({ content: [{ type: "text", text: "ok" }] });
		});

		it("returns the upstream result untouched when the parsed PR is missing number/head.sha", async () => {
			upstream.forward.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ title: "no head here" }) }] });
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out = await r.call("pull_request_read", { owner: "cldmv", repo: "gh-broker", pullNumber: 5, method: "get", ciVerbosity: 0 });
			expect(out).toEqual({ content: [{ type: "text", text: JSON.stringify({ title: "no head here" }) }] });
			expect(Octokit).not.toHaveBeenCalled();
		});
	});
});
