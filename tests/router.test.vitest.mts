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
			{ name: "report_unlabeled", mode: "read", custom: true }
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
	});
});
