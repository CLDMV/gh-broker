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
			{ name: "issue_labels", mode: "write", custom: true },
			{ name: "report_unlabeled", mode: "read", custom: true },
			{ name: "report_security_alerts", mode: "read", custom: true },
			{ name: "report_release_prs", mode: "read", custom: true },
			{ name: "report_release_changes", mode: "read", custom: true },
			{ name: "report_alert_status", mode: "read", custom: true },
			{ name: "report_dependents", mode: "read", custom: true },
			{ name: "report_ci_status", mode: "read", custom: true },
			{ name: "pull_request_read", mode: "read", augment: true },
			{ name: "list_pull_requests", mode: "read", augment: true }
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
		secrets = { resolve: vi.fn((ref: string) => `token:${ref}`), has: vi.fn(() => true) };
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
		expect(r.advertisedTools()).toEqual(cfg.tools);
	});

	it("advertisedTools leaves out a tool whose optional integration is not set up", () => {
		const cfg = makeConfig({ tools: [{ name: "get_me", mode: "read" }, { name: "npm_scaffold", mode: "write", custom: true }] });
		expect(new Router(cfg, secrets as any, upstream as any).advertisedTools().map((t) => t.name)).toEqual(["get_me"]);
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

		it("npm_scaffold is unavailable without an npm block, before any credential is read", async () => {
			const r = new Router(makeConfig({ tools: [{ name: "npm_scaffold", mode: "write", custom: true }] }), secrets as any, upstream as any);
			await expect(r.call("npm_scaffold", { owner: "cldmv", repo: "x", package: "@cldmv/x", otp: "123456" })).rejects.toThrow(
				/tool "npm_scaffold" is not available on this broker: the npm integration is not configured/
			);
			expect(secrets.resolve).not.toHaveBeenCalled();
		});

		it("npm_scaffold is unavailable when its token is not stored", async () => {
			secrets.has.mockImplementation((ref: string) => ref !== "cred:npm-token");
			const cfg = makeConfig({ tools: [{ name: "npm_scaffold", mode: "write", custom: true }], npm: { token: "cred:npm-token", scopes: ["@cldmv"] } });
			const r = new Router(cfg, secrets as any, upstream as any);
			await expect(r.call("npm_scaffold", { owner: "cldmv", repo: "x", package: "@cldmv/x", otp: "123456" })).rejects.toThrow(/its credential "npm-token" is not stored/);
			expect(secrets.resolve).not.toHaveBeenCalled();
		});

		it("npm_scaffold reads GitHub on the READ PAT and resolves the npm token", async () => {
			requestMock.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
			const cfg = makeConfig({ tools: [{ name: "npm_scaffold", mode: "write", custom: true }], npm: { token: "cred:npm-token", scopes: ["@cldmv"] } });
			const r = new Router(cfg, secrets as any, upstream as any);
			await expect(r.call("npm_scaffold", { owner: "cldmv", repo: "x", package: "@cldmv/x", otp: "123456" })).rejects.toThrow(/repository cldmv\/x not found/);
			expect(Octokit).toHaveBeenLastCalledWith({ auth: "token:cred:cldmv-read" });
			expect(secrets.resolve).toHaveBeenCalledWith("cred:npm-token");
		});

		it("npm_scaffold publishes through the configured registry and returns the verb's result", async () => {
			const b64 = (x: string) => Buffer.from(x).toString("base64");
			requestMock.mockImplementation(async (route: string, p: any) => {
				if (route === "GET /repos/{owner}/{repo}") return { data: { full_name: "CLDMV/x", private: false, default_branch: "master" } };
				if (p.path === "package.json") return { data: { type: "file", encoding: "base64", content: b64('{"name":"@cldmv/x"}') } };
				return { data: { type: "file", encoding: "base64", content: b64("name: publish") } };
			});
			const urls: string[] = [];
			const fetchMock = vi.fn(async (url: string, init: any) => {
				urls.push(`${init.method} ${url}`);
				return { status: init.method === "GET" ? 404 : 200, headers: { get: () => null }, text: async () => "{}" };
			});
			vi.stubGlobal("fetch", fetchMock);
			try {
				const cfg = makeConfig({ tools: [{ name: "npm_scaffold", mode: "write", custom: true }], npm: { token: "cred:npm-token", scopes: ["@cldmv"], registry: "https://npm.example.test" } });
				const r = new Router(cfg, secrets as any, upstream as any);
				const out = await r.call("npm_scaffold", { owner: "cldmv", repo: "x", package: "@cldmv/x", otp: "123456" });
				expect(JSON.parse((out.content[0] as any).text)).toMatchObject({ status: "needs_otp", done: ["publish"], remaining: ["trust"] });
				expect(urls).toEqual(["GET https://npm.example.test/@cldmv%2fx?write=true", "PUT https://npm.example.test/@cldmv%2fx"]);
				expect(fetchMock.mock.calls[1]![1].headers.authorization).toBe("Bearer token:cred:npm-token");
			} finally {
				vi.unstubAllGlobals();
			}
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

		it("issue_labels runs on a write-PAT Octokit and returns the resulting label set as JSON text", async () => {
			requestMock.mockImplementation(async (route: string) => {
				if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels") return { data: [{ name: "type: bug" }] };
				if (route === "GET /repos/{owner}/{repo}/labels/{name}") return { data: { name: "area: auth" } };
				return { data: [{ name: "type: bug" }, { name: "area: auth" }] };
			});
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out = await r.call("issue_labels", { owner: "CLDMV", repo: "gh-broker", issue_number: 117, add: "area: auth" });
			expect(Octokit).toHaveBeenCalledWith({ auth: "token:cred:cldmv-write" });
			expect(JSON.parse((out.content[0] as { text: string }).text)).toEqual({
				issue: "CLDMV/gh-broker#117",
				labels: ["type: bug", "area: auth"],
				added: ["area: auth"],
				removed: [],
				created: []
			});
			expect(upstream.forward).not.toHaveBeenCalled();
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

		it("report_security_alerts runs on a read-PAT Octokit and returns the JSON report as text", async () => {
			requestMock.mockResolvedValue({ data: [], headers: {} });
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out = await r.call("report_security_alerts", { owner: "cldmv" });
			expect(Octokit).toHaveBeenCalledWith({ auth: "token:cred:cldmv-read" });
			expect(out).toEqual({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							scanned: {},
							scope: { dependabot: "org", codeql: "org", secrets: "org" },
							counts: { dependabot: {}, codeql: {}, secrets: {} },
							byRepo: [],
							alerts: []
						})
					}
				]
			});
		});

		it("report_release_prs runs on a read-PAT Octokit and returns the JSON report as text", async () => {
			requestMock.mockResolvedValue({ data: { total_count: 0, incomplete_results: false, items: [] }, headers: {} });
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out = await r.call("report_release_prs", { owner: "cldmv" });
			expect(Octokit).toHaveBeenCalledWith({ auth: "token:cred:cldmv-read" });
			expect(out).toEqual({
				content: [
					{
						type: "text",
						text: JSON.stringify({ scanned: { releasePrs: 0 }, summary: { ready: 0, needsChangelog: 0, unknownVersion: 0 }, releasePrs: [] })
					}
				]
			});
		});

		it("report_release_changes runs on a read-PAT Octokit and returns the JSON report as text", async () => {
			requestMock.mockRejectedValueOnce(Object.assign(new Error("Too Many Requests"), { status: 429 }));
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out = await r.call("report_release_changes", { owner: "cldmv", repo: "gh-broker", pull: 5 });
			expect(Octokit).toHaveBeenCalledWith({ auth: "token:cred:cldmv-read" });
			expect(JSON.parse((out.content[0] as { text: string }).text)).toEqual({
				repo: "cldmv/gh-broker",
				pull: 5,
				prs: [],
				groups: { breaking: [], features: [], fixes: [], security: [], ciTooling: [], documentation: [], dependencies: [], ungrouped: [] },
				excluded: [],
				hotfixes: [],
				truncated: true,
				truncatedReason: "rate-limited"
			});
		});
		it("report_alert_status runs on a read-PAT Octokit and returns the JSON report as text", async () => {
			requestMock.mockResolvedValue({ data: [], headers: {} });
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out = await r.call("report_alert_status", { owner: "cldmv", repo: "r" });
			expect(Octokit).toHaveBeenCalledWith({ auth: "token:cred:cldmv-read" });
			expect(out).toEqual({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							scanned: { repos: 0, alerts: 0 },
							scope: "repo",
							summary: { "released-still-open": 0, "fixed-on-next": 0, "open-pr": 0, "closed-unmerged": 0, "no-pr": 0 },
							repos: []
						})
					}
				]
			});
		});

		it("report_dependents runs on a read-PAT Octokit and returns the JSON report as text", async () => {
			requestMock.mockResolvedValue({ data: { total_count: 0, incomplete_results: false, items: [] }, headers: {} });
			const r = new Router(makeConfig(), secrets as any, upstream as any);
			const out = await r.call("report_dependents", { owner: "cldmv", name: "@cldmv/x" });
			expect(Octokit).toHaveBeenCalledWith({ auth: "token:cred:cldmv-read" });
			expect(JSON.parse((out as any).content[0].text)).toMatchObject({ package: "@cldmv/x", scanned: { candidates: 0 }, dependents: [] });
		});

		it("report_dependents looks up latest on the configured npm registry", async () => {
			requestMock.mockResolvedValue({ data: { total_count: 0, incomplete_results: false, items: [] }, headers: {} });
			const fetchMock = vi.fn(async () => ({ status: 200, headers: { get: () => null }, text: async () => '{"version":"2.0.0"}' }));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const cfg = makeConfig({ npm: { token: "cred:npm-token", scopes: ["@cldmv"], registry: "https://npm.example.test" } });
				const r = new Router(cfg, secrets as any, upstream as any);
				const out = await r.call("report_dependents", { owner: "cldmv", name: "@cldmv/x", latest: true });
				expect(fetchMock.mock.calls[0]![0]).toBe("https://npm.example.test/@cldmv%2fx/latest");
				expect(JSON.parse((out as any).content[0].text).latest).toBe("2.0.0");
			} finally {
				vi.unstubAllGlobals();
			}
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

		describe("list_pull_requests", () => {
			const listText = (items: unknown) => ({ content: [{ type: "text", text: JSON.stringify(items) }] });
			const prs = [
				{ number: 5, title: "a", head: { sha: "s5" } },
				{ number: 6, title: "b", head: { sha: "s6" } }
			];
			const base = { owner: "cldmv", repo: "gh-broker", state: "open" };

			it("forwards byte-identically when ciVerbosity is absent", async () => {
				upstream.forward.mockResolvedValue(listText(prs));
				const r = new Router(makeConfig(), secrets as any, upstream as any);
				const out = await r.call("list_pull_requests", base);
				expect(out).toEqual(listText(prs));
				expect(upstream.forward).toHaveBeenCalledWith("list_pull_requests", base, "token:cred:cldmv-read");
				expect(Octokit).not.toHaveBeenCalled();
			});

			it("tier 0 adds a ci summary to each item, strips the extension params and keeps other fields", async () => {
				upstream.forward.mockResolvedValue(listText(prs));
				requestMock
					.mockResolvedValueOnce({ data: { workflow_runs: [{ id: 1, name: "CI", status: "completed", conclusion: "failure", html_url: "u" }] }, headers: {} })
					.mockResolvedValueOnce({ data: { workflow_runs: [] }, headers: {} });
				const r = new Router(makeConfig(), secrets as any, upstream as any);
				const out: any = await r.call("list_pull_requests", { ...base, ciVerbosity: 0, logLines: 5, maxDetail: 1 });
				expect(upstream.forward).toHaveBeenCalledWith("list_pull_requests", base, "token:cred:cldmv-read");
				expect(JSON.parse(out.content[0].text)).toEqual([
					{ ...prs[0], ci: { pull: 5, summary: { passed: 0, failed: 1, pending: 0 } } },
					{ ...prs[1], ci: { pull: 6, summary: { passed: 0, failed: 0, pending: 0 } } }
				]);
			});

			it("tier 1 caps detail at maxDetail and flags the rest", async () => {
				upstream.forward.mockResolvedValue(listText(prs));
				const failing = { id: 1, name: "CI", status: "completed", conclusion: "failure", html_url: "u" };
				requestMock.mockImplementation(async (route: string) =>
					route.endsWith("/jobs")
						? { data: { jobs: [{ id: 7, name: "test", status: "completed", conclusion: "failure", html_url: "j", steps: [] }] }, headers: {} }
						: { data: { workflow_runs: [failing] }, headers: {} }
				);
				const r = new Router(makeConfig(), secrets as any, upstream as any);
				const out: any = await r.call("list_pull_requests", { ...base, ciVerbosity: 1, maxDetail: 1 });
				const items = JSON.parse(out.content[0].text);
				expect(items[0].ci.failures).toEqual([{ workflow: "CI", job: "test", runId: 1, runUrl: "u", conclusion: "failure" }]);
				expect(items[1].ci).toEqual({ pull: 6, summary: { passed: 0, failed: 1, pending: 0 }, truncated: true, truncatedReason: "max-detail" });
			});

			it("tier 3 fetches failing job logs via get_job_logs", async () => {
				upstream.forward.mockImplementation(async (tool: string) => {
					if (tool === "list_pull_requests") return listText([prs[0]]);
					return { content: [{ type: "text", text: JSON.stringify({ logs: [{ job_id: 7, logs_content: "boom" }] }) }] };
				});
				requestMock.mockImplementation(async (route: string) =>
					route.endsWith("/jobs")
						? { data: { jobs: [{ id: 7, name: "test", status: "completed", conclusion: "failure", html_url: "j", steps: [] }] }, headers: {} }
						: { data: { workflow_runs: [{ id: 1, name: "CI", status: "completed", conclusion: "failure", html_url: "u" }] }, headers: {} }
				);
				const r = new Router(makeConfig(), secrets as any, upstream as any);
				const out: any = await r.call("list_pull_requests", { ...base, ciVerbosity: 3, logLines: 9 });
				expect(upstream.forward).toHaveBeenCalledWith("get_job_logs", expect.objectContaining({ run_id: 1, tail_lines: 9 }), "token:cred:cldmv-read");
				expect(JSON.parse(out.content[0].text)[0].ci.failures[0].logTail).toBe("boom");
			});

			it("marks PRs truncated once the rate-limit floor is hit", async () => {
				upstream.forward.mockResolvedValue(listText(prs));
				requestMock.mockResolvedValue({ data: { workflow_runs: [] }, headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "10" } });
				const r = new Router(makeConfig(), secrets as any, upstream as any);
				const out: any = await r.call("list_pull_requests", { ...base, ciVerbosity: 0 });
				const items = JSON.parse(out.content[0].text);
				expect(items.map((i: any) => i.ci.truncatedReason)).toEqual(["rate-limited", "rate-limited"]);
				expect(requestMock).toHaveBeenCalledTimes(1);
			});

			it("leaves items without number/head.sha untouched and resolves a missing repo to empty", async () => {
				upstream.forward.mockResolvedValue(listText([null, { title: "odd" }, prs[0]]));
				requestMock.mockResolvedValueOnce({ data: { workflow_runs: [] }, headers: {} });
				const r = new Router(makeConfig(), secrets as any, upstream as any);
				const out: any = await r.call("list_pull_requests", { owner: "cldmv", ciVerbosity: 0 });
				expect(JSON.parse(out.content[0].text)).toEqual([null, { title: "odd" }, { ...prs[0], ci: { pull: 5, summary: { passed: 0, failed: 0, pending: 0 } } }]);
			});

			it("returns the result untouched for no text block, non-JSON, non-array, or nothing to look up", async () => {
				const r = new Router(makeConfig(), secrets as any, upstream as any);
				for (const res of [{ content: [] }, { content: [{ type: "text", text: "not json" }] }, listText({ not: "an array" }), listText([]), listText([{ title: "x" }])]) {
					upstream.forward.mockResolvedValue(res);
					expect(await r.call("list_pull_requests", { ...base, ciVerbosity: 0 })).toEqual(res);
				}
				expect(Octokit).not.toHaveBeenCalled();
			});
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

describe("Router.call — GHCR verbs", () => {
	const ghcr = { dropDir: "/srv/gh-broker/ghcr-drop", protectReleaseTags: true, maxArchiveBytes: 1024, owners: { cldmv: { username: "u", credential: "cred:cldmv-packages", images: ["hoot"] } } };
	const tools = [
		{ name: "ghcr_push", mode: "write", custom: true },
		{ name: "ghcr_push_status", mode: "read", custom: true },
		{ name: "ghcr_tags", mode: "read", custom: true }
	];
	let secrets: { resolve: ReturnType<typeof vi.fn> };
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		secrets = { resolve: vi.fn((ref: string) => `token:${ref}`), has: vi.fn(() => true) };
	});
	afterEach(() => vi.restoreAllMocks());

	it("dispatches ghcr_push_status to the GHCR service and returns JSON", async () => {
		const r = new Router(makeConfig({ tools, ghcr }), secrets as any, { forward: vi.fn() } as any);
		expect(await r.call("ghcr_push_status", { owner: "cldmv" })).toEqual({ content: [{ type: "text", text: JSON.stringify({ jobs: [] }) }] });
	});

	it("passes GHCR refusals through (allowlist checked before any network call or GHCR credential read)", async () => {
		const r = new Router(makeConfig({ tools, ghcr }), secrets as any, { forward: vi.fn() } as any);
		await expect(r.call("ghcr_tags", { owner: "cldmv", image: "private" })).rejects.toThrow(/not on the allowlist/);
		await expect(r.call("ghcr_push", { owner: "cldmv", image: "private", tag: "t", archive: "a.tar" })).rejects.toThrow(/not on the allowlist/);
		expect(secrets.resolve).not.toHaveBeenCalledWith("cred:cldmv-packages");
	});

	it("audits and rethrows a GHCR call that names no owner", async () => {
		const r = new Router(makeConfig({ tools, ghcr }), secrets as any, { forward: vi.fn() } as any);
		await expect(r.call("ghcr_push_status", {})).rejects.toThrow();
	});

	it("refuses GHCR verbs when config.ghcr is absent", async () => {
		const r = new Router(makeConfig({ tools }), secrets as any, { forward: vi.fn() } as any);
		await expect(r.call("ghcr_push", { owner: "cldmv", image: "hoot", tag: "t", archive: "a" })).rejects.toThrow(/tool "ghcr_push" is not available on this broker: GHCR pushes are not configured/);
	});

	it("refuses an owner whose GHCR credential is not stored, while another owner's is", async () => {
		const ghcr = {
			dropDir: "/srv/x/drop",
			protectReleaseTags: true,
			maxArchiveBytes: 1,
			owners: { cldmv: { username: "u", credential: "cred:cldmv-packages", images: ["hoot"] }, other: { username: "o", credential: "cred:other-packages", images: ["x"] } }
		};
		secrets.has.mockImplementation((ref: string) => ref === "cred:other-packages");
		const r = new Router(makeConfig({ tools, ghcr }), secrets as any, { forward: vi.fn() } as any);
		await expect(r.call("ghcr_push_status", { owner: "cldmv" })).rejects.toThrow(/owner "cldmv"'s GHCR credential "cldmv-packages" is not stored/);
		await expect(r.call("ghcr_push_status", { owner: "other" })).resolves.toMatchObject({ content: [{ type: "text" }] });
		expect(secrets.resolve).not.toHaveBeenCalledWith("cred:cldmv-packages");
	});
});
