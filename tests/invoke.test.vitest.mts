import { describe, it, expect, vi, beforeEach } from "vitest";

const { connectMock, callToolMock, closeMock, requestMock } = vi.hoisted(() => ({
	connectMock: vi.fn(),
	callToolMock: vi.fn(),
	closeMock: vi.fn(),
	requestMock: vi.fn()
}));

// The library's per-call forwarder builds its own MCP client; mock the SDK so the pins
// run without a network (the same shape tests/upstream.test.vitest.mts uses). Octokit is
// `new`-ed inside the local verbs' dispatch, so it is mocked the same way router.test does.
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn(function (this: any) {
		this.connect = connectMock;
		this.callTool = callToolMock;
		this.close = closeMock;
	})
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: vi.fn(function () {})
}));
vi.mock("@octokit/core", () => ({
	Octokit: vi.fn(function (this: any) {
		this.request = requestMock;
	})
}));

import { createBroker, InvokeError, perCallUpstream } from "../src/invoke.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * A strict host's lib-config. Every tool is IN the manifest (strict is the default
 * policy: manifest-less tools don't exist — the config-only get_me/create_pull_request
 * shape the daemon tests use is exactly what a strict host must refuse).
 */
function makeConfig(overrides: Record<string, unknown> = {}): any {
	return {
		tools: [
			// forwarded read (ungated, augmentable)
			{ name: "pull_request_read", mode: "read" },
			// forwarded write (ungated)
			{ name: "issue_write", mode: "write" },
			// forwarded write, manifest-gated (DEFAULT_GATED)
			{ name: "merge_pull_request", mode: "write" },
			// local verb, ungated
			{ name: "issue_labels", mode: "write" },
			// default-off in the manifest
			{ name: "create_pull_request_with_copilot", mode: "write" }
		],
		owners: { cldmv: { read: "cred:cldmv-read", write: "cred:cldmv-write" } },
		defaultOwner: "cldmv",
		...overrides
	};
}

function mkCtx(over: Record<string, unknown> = {}) {
	return {
		person: "tester",
		resolveToken: vi.fn(async (req: { owner?: string; mode: string }) => `token:${req.owner}:${req.mode}`),
		signal: new AbortController().signal,
		now: 0,
		approve: vi.fn(async () => "ok" as const),
		...over
	} as any;
}

function mkUpstream() {
	return { forward: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }) };
}

describe("invoke — the policy gate (strict by default, design #175 §2h)", () => {
	let upstream: ReturnType<typeof mkUpstream>;
	beforeEach(() => {
		upstream = mkUpstream();
	});

	it("refuses an unknown tool with a typed error", async () => {
		const { invoke } = createBroker(makeConfig());
		const err = await invoke("totally_unknown", {}, mkCtx({ upstream })).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(InvokeError);
		expect((err as InvokeError).code).toBe("unknown-tool");
		expect((err as Error).message).toBe('tool "totally_unknown" is not allowed');
		expect(upstream.forward).not.toHaveBeenCalled();
	});

	it("refuses a manifest tool that is not in the host's rules at all", async () => {
		// issue_write exists in the manifest but the host's rules omit it: strict says it
		// doesn't exist on this host either.
		const { invoke } = createBroker(makeConfig({ tools: [makeConfig().tools[0]] }));
		await expect(invoke("issue_write", { owner: "cldmv", repo: "x" }, mkCtx({ upstream }))).rejects.toMatchObject({ code: "unknown-tool" });
	});

	it("refuses a default-off tool unless the rule enables it", async () => {
		const { invoke } = createBroker(makeConfig());
		await expect(invoke("create_pull_request_with_copilot", { owner: "cldmv", repo: "x", problem_statement: "p" }, mkCtx({ upstream }))).rejects.toMatchObject({
			code: "unknown-tool"
		});
		const enabled = createBroker(
			makeConfig({ tools: [...makeConfig().tools.slice(0, -1), { name: "create_pull_request_with_copilot", mode: "write", enabled: true }] })
		);
		await enabled.invoke("create_pull_request_with_copilot", { owner: "cldmv", repo: "x", problem_statement: "p" }, mkCtx({ upstream }));
		expect(upstream.forward).toHaveBeenCalledTimes(1);
	});

	it("refuses a rule the host disabled outright", async () => {
		const { invoke } = createBroker(makeConfig({ tools: [{ name: "issue_write", mode: "write", enabled: false }] }));
		await expect(invoke("issue_write", { owner: "cldmv", repo: "x" }, mkCtx({ upstream }))).rejects.toMatchObject({ code: "disabled" });
	});

	it("refuses npm_scaffold with no npm integration, typed, before any dispatch", async () => {
		const { invoke } = createBroker(makeConfig({ tools: [{ name: "npm_scaffold", mode: "write" }] }));
		await expect(invoke("npm_scaffold", { owner: "cldmv" }, mkCtx({ upstream }))).rejects.toMatchObject({
			code: "unavailable",
			message: /the npm integration is not configured/
		});
	});
});

describe("invoke — the approve seam (round-3 M5)", () => {
	let upstream: ReturnType<typeof mkUpstream>;
	beforeEach(() => {
		upstream = mkUpstream();
	});

	it("runs a gated tool through approve, strips the otp argument before dispatch, and forwards", async () => {
		const { invoke } = createBroker(makeConfig());
		const ctx = mkCtx({ upstream });
		await invoke("merge_pull_request", { owner: "cldmv", repo: "x", pullNumber: 1, otp: "123456" }, ctx);
		expect(ctx.approve).toHaveBeenCalledTimes(1);
		expect(ctx.approve).toHaveBeenCalledWith("merge_pull_request", "tester", { owner: "cldmv", repo: "x", pullNumber: 1, otp: "123456" });
		expect(upstream.forward).toHaveBeenCalledWith("merge_pull_request", { owner: "cldmv", repo: "x", pullNumber: 1 }, "token:cldmv:write");
	});

	it("an approve refusal is the typed refusal, verbatim, and the security sink sees it", async () => {
		const { invoke } = createBroker(makeConfig());
		const security = vi.fn();
		const ctx = mkCtx({ upstream, audit: { security }, approve: vi.fn(async () => ({ code: "otp-bad", message: "that code was not accepted" })) });
		await expect(invoke("merge_pull_request", { owner: "cldmv", repo: "x", otp: "000000" }, ctx)).rejects.toSatisfy((err: unknown) => {
			expect(err).toBeInstanceOf(InvokeError);
			expect((err as InvokeError).code).toBe("otp-bad");
			expect((err as Error).message).toBe("that code was not accepted");
			return true;
		});
		expect(security).toHaveBeenCalledWith({ kind: "code-bad", tool: "merge_pull_request", person: "tester", failures: 0 });
		expect(upstream.forward).not.toHaveBeenCalled();
	});

	it("a host without approve fails closed on a gated tool: otp-required, nothing run", async () => {
		const { invoke } = createBroker(makeConfig());
		const ctx = mkCtx({ upstream });
		delete ctx.approve;
		await expect(invoke("merge_pull_request", { owner: "cldmv", repo: "x" }, ctx)).rejects.toMatchObject({ code: "otp-required" });
		expect(upstream.forward).not.toHaveBeenCalled();
	});

	it("a non-gated tool never calls approve", async () => {
		const { invoke } = createBroker(makeConfig());
		const ctx = mkCtx({ upstream });
		requestMock.mockImplementation((route: string) => {
			if (route.startsWith("GET /repos/{owner}/{repo}/issues/")) return { data: [] };
			if (route.startsWith("GET /repos/{owner}/{repo}/labels/")) return { data: { name: "bug" } };
			if (route.startsWith("POST /repos/{owner}/{repo}/issues/")) return { data: [{ name: "bug" }] };
			throw new Error(`unexpected route ${route}`);
		});
		await invoke("issue_labels", { owner: "cldmv", repo: "x", issue_number: 1, add: ["bug"] }, ctx);
		expect(ctx.approve).not.toHaveBeenCalled();
		expect(upstream.forward).not.toHaveBeenCalled(); // a local verb never forwards
	});
});

describe("invoke — tokens and owners", () => {
	let upstream: ReturnType<typeof mkUpstream>;
	beforeEach(() => {
		upstream = mkUpstream();
	});

	it("a write call asks the resolver for the write PAT, a read call for the read PAT", async () => {
		const { invoke } = createBroker(makeConfig());
		await invoke("issue_write", { owner: "CLDMV", repo: "x", title: "t" }, mkCtx({ upstream }));
		await invoke("pull_request_read", { owner: "CLDMV", repo: "x", pullNumber: 1 }, mkCtx({ upstream }));
		expect(upstream.forward).toHaveBeenNthCalledWith(1, "issue_write", { owner: "CLDMV", repo: "x", title: "t" }, "token:cldmv:write");
		expect(upstream.forward).toHaveBeenNthCalledWith(2, "pull_request_read", { owner: "CLDMV", repo: "x", pullNumber: 1 }, "token:cldmv:read");
	});

	it("an owner-less read falls back to defaultOwner's READ PAT; a write never falls back", async () => {
		const { invoke } = createBroker(makeConfig());
		await invoke("pull_request_read", {}, mkCtx({ upstream }));
		expect(upstream.forward).toHaveBeenCalledWith("pull_request_read", {}, "token:cldmv:read");
		await expect(invoke("issue_write", { repo: "x" }, mkCtx({ upstream }))).rejects.toMatchObject({ code: "no-owner" });
	});

	it("a null token fails closed: typed no-access error, no forward, no token in the message", async () => {
		const { invoke } = createBroker(makeConfig());
		const ctx = mkCtx({ upstream, resolveToken: vi.fn(async () => null) });
		await expect(invoke("pull_request_read", { owner: "cldmv" }, ctx)).rejects.toSatisfy((err: unknown) => {
			expect(err).toBeInstanceOf(InvokeError);
			expect((err as InvokeError).code).toBe("no-access");
			expect((err as Error).message).toBe('no credentials configured for owner "cldmv" — add it to config.owners + creds');
			return true;
		});
		expect(upstream.forward).not.toHaveBeenCalled();
	});
});

describe("invoke — the result", () => {
	let upstream: ReturnType<typeof mkUpstream>;
	beforeEach(() => {
		upstream = mkUpstream();
	});

	it("a forwarded call carries mcpTarget and the upstream's own result object", async () => {
		const { invoke } = createBroker(makeConfig());
		const upstreamResult = { content: [{ type: "text", text: "ok" }] };
		upstream.forward.mockResolvedValue(upstreamResult);
		const out = await invoke("pull_request_read", { owner: "cldmv" }, mkCtx({ upstream }));
		expect(out).toEqual({ tool: "pull_request_read", mode: "read", mcpTarget: "pull_request_read", result: upstreamResult });
	});

	it("a local verb carries no mcpTarget", async () => {
		const { invoke } = createBroker(makeConfig());
		requestMock.mockImplementation((route: string) => {
			if (route.startsWith("GET /repos/{owner}/{repo}/issues/")) return { data: [] };
			if (route.startsWith("GET /repos/{owner}/{repo}/labels/")) return { data: { name: "bug" } };
			if (route.startsWith("POST /repos/{owner}/{repo}/issues/")) return { data: [{ name: "bug" }] };
			throw new Error(`unexpected route ${route}`);
		});
		const out = await invoke("issue_labels", { owner: "cldmv", repo: "x", issue_number: 1, add: ["bug"] }, mkCtx({ upstream }));
		expect(out.mcpTarget).toBeUndefined();
		expect(out.mode).toBe("write");
	});
});

describe("perCallUpstream — the library's per-call forwarder (design #175 §2a)", () => {
	beforeEach(() => {
		vi.mocked(Client).mockClear();
		vi.mocked(StreamableHTTPClientTransport).mockClear();
		connectMock.mockReset().mockResolvedValue(undefined);
		callToolMock.mockReset().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		closeMock.mockReset().mockResolvedValue(undefined);
	});

	it("connects a fresh client per call with the bearer token, and closes it afterwards", async () => {
		const upstream = perCallUpstream("https://api.githubcopilot.com/mcp/");
		const first = await upstream.forward("get_me", { a: 1 }, "TOK-A");
		const second = await upstream.forward("get_me", { a: 2 }, "TOK-B");
		expect(first).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(second).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(Client).toHaveBeenCalledTimes(2); // no pooling: one connection per call
		expect(StreamableHTTPClientTransport).toHaveBeenNthCalledWith(1, new URL("https://api.githubcopilot.com/mcp/"), {
			requestInit: { headers: { Authorization: "Bearer TOK-A" } }
		});
		expect(StreamableHTTPClientTransport).toHaveBeenNthCalledWith(2, new URL("https://api.githubcopilot.com/mcp/"), {
			requestInit: { headers: { Authorization: "Bearer TOK-B" } }
		});
		expect(callToolMock).toHaveBeenNthCalledWith(1, { name: "get_me", arguments: { a: 1 } });
		expect(closeMock).toHaveBeenCalledTimes(2);
	});

	it("closes the connection even when the call fails, and never caches it", async () => {
		callToolMock.mockRejectedValueOnce(new Error("upstream boom"));
		const upstream = perCallUpstream("https://api.githubcopilot.com/mcp/");
		await expect(upstream.forward("get_me", {}, "TOK")).rejects.toThrow("upstream boom");
		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	it("createBroker uses ctx.upstream when given, the library forwarder only when not", async () => {
		const { invoke } = createBroker(makeConfig(), { upstreamUrl: "https://mcp.example/mcp/" });
		await invoke("pull_request_read", { owner: "cldmv" }, mkCtx());
		expect(Client).toHaveBeenCalledTimes(1); // the library forwarder served the call
		const own = mkUpstream();
		await invoke("pull_request_read", { owner: "cldmv" }, mkCtx({ upstream: own }));
		expect(Client).toHaveBeenCalledTimes(1); // unchanged: ctx.upstream took over
		expect(own.forward).toHaveBeenCalledTimes(1);
	});

	it("a forwarded tool with no upstream at all fails closed", async () => {
		const { invoke } = createBroker(makeConfig());
		await expect(invoke("pull_request_read", { owner: "cldmv" }, mkCtx())).rejects.toMatchObject({ code: "no-upstream" });
	});
});
