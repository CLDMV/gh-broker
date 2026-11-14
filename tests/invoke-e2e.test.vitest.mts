import { describe, it, expect, vi } from "vitest";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

// The local verbs dispatch through a real Octokit instance; mock it the way router.test
// does so the end-to-end host runs without a network.
vi.mock("@octokit/core", () => ({
	Octokit: vi.fn(function (this: any) {
		this.request = requestMock;
	})
}));

import { createBroker, InvokeError } from "../src/invoke.ts";
import type { InvokeCtx } from "../src/invoke.ts";

// The parent's centerpiece pins (slice 5): a STRICT-policy host end to end through
// invoke — policy gate, approve seam, resolver, dispatch — with the daemon's output
// contract pinned alongside (invoke returns the dispatch's own result; wrapping into
// MCP content blocks stays the host's job, as today).

const STORED = new Set(["cred:cldmv-read", "cred:cldmv-write", "cred:otp-seed", "cred:npm-token"]);

/** A strict host: the manifest is the universe, one owner, a credential store behind the capability. */
function host(overrides: Record<string, unknown> = {}) {
	const config: any = {
		tools: [
			{ name: "pull_request_read", mode: "read" },
			{ name: "issue_write", mode: "write" },
			// manifest-gated (DEFAULT_GATED)
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
	const capability = { has: (ref: string) => STORED.has(ref), otpProblem: () => undefined };
	const upstream = { forward: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }) };
	const requests: unknown[] = [];
	const resolveToken = vi.fn(async (req: { person: string; owner?: string; mode: string; kind: string }) => {
		requests.push(req);
		const ref = req.kind === "npm" ? "cred:npm-token" : req.mode === "write" ? `cred:${req.owner}-write` : `cred:${req.owner}-read`;
		return STORED.has(ref) ? `token:${ref}` : null;
	});
	const security = vi.fn();
	// The OTP elicitation seam: only the current code passes.
	const approve = vi.fn(async (_tool: string, _person: string, args: { otp?: unknown }) =>
		args?.otp === "654321" ? ("ok" as const) : { code: "otp-bad", message: "that code was not accepted" }
	);
	const broker = createBroker(config, { capability });
	const ctx = (over: Record<string, unknown> = {}): InvokeCtx =>
		({ person: "tester", resolveToken, signal: new AbortController().signal, now: 0, approve, audit: { security }, upstream, ...over }) as InvokeCtx;
	return { broker, ctx, upstream, resolveToken, approve, security, requests };
}

describe("end to end: a strict host through invoke (design #175 §2b/§2h)", () => {
	it("an unknown tool is refused before anything runs", async () => {
		const h = host();
		await expect(h.broker.invoke("totally_unknown", {}, h.ctx())).rejects.toSatisfy((err: unknown) => {
			expect(err).toBeInstanceOf(InvokeError);
			expect((err as InvokeError).code).toBe("unknown-tool");
			return true;
		});
		expect(h.upstream.forward).not.toHaveBeenCalled();
		expect(h.resolveToken).not.toHaveBeenCalled();
		expect(h.approve).not.toHaveBeenCalled();
	});

	it("a default-off tool is refused unless the host enables it", async () => {
		const h = host();
		await expect(h.broker.invoke("create_pull_request_with_copilot", { owner: "cldmv", repo: "x", problem_statement: "p" }, h.ctx())).rejects.toMatchObject({
			code: "unknown-tool"
		});
		const on = host({
			tools: [
				{ name: "pull_request_read", mode: "read" },
				{ name: "create_pull_request_with_copilot", mode: "write", enabled: true }
			]
		});
		await on.broker.invoke("create_pull_request_with_copilot", { owner: "cldmv", repo: "x", problem_statement: "p", otp: "654321" }, on.ctx());
		expect(on.upstream.forward).toHaveBeenCalledTimes(1);
		expect(on.approve).toHaveBeenCalledTimes(1); // gated once enabled
	});

	it("a gated tool without approval is refused: the typed refusal, and the security sink sees it", async () => {
		const h = host();
		const ctx = h.ctx({ approve: vi.fn(async () => ({ code: "otp-expired", message: "that code has expired" })) });
		await expect(h.broker.invoke("merge_pull_request", { owner: "cldmv", repo: "x", pullNumber: 1, otp: "000000" }, ctx)).rejects.toSatisfy((err: unknown) => {
			expect(err).toBeInstanceOf(InvokeError);
			expect((err as InvokeError).code).toBe("otp-expired");
			expect((err as Error).message).toBe("that code has expired");
			return true;
		});
		expect(h.security).toHaveBeenCalledWith({ kind: "code-bad", tool: "merge_pull_request", person: "tester", failures: 0 });
		expect(h.upstream.forward).not.toHaveBeenCalled();
	});

	it("a host without approve on a gated tool fails closed with otp-required", async () => {
		const h = host();
		const ctx = h.ctx();
		delete (ctx as { approve?: unknown }).approve;
		await expect(h.broker.invoke("merge_pull_request", { owner: "cldmv", repo: "x", otp: "654321" }, ctx)).rejects.toMatchObject({ code: "otp-required" });
		expect(h.upstream.forward).not.toHaveBeenCalled();
	});

	it("a non-gated tool runs without approve being called", async () => {
		const h = host();
		requestMock.mockImplementation((route: string) => {
			if (route.startsWith("GET /repos/{owner}/{repo}/issues/")) return { data: [] };
			if (route.startsWith("GET /repos/{owner}/{repo}/labels/")) return { data: { name: "bug" } };
			if (route.startsWith("POST /repos/{owner}/{repo}/issues/")) return { data: [{ name: "bug" }] };
			throw new Error(`unexpected route ${route}`);
		});
		await h.broker.invoke("issue_labels", { owner: "cldmv", repo: "x", issue_number: 1, add: ["bug"] }, h.ctx());
		expect(h.approve).not.toHaveBeenCalled();
		expect(h.upstream.forward).not.toHaveBeenCalled(); // dispatched locally
	});

	it("write gets write and read gets read through the host's resolver", async () => {
		const h = host();
		await h.broker.invoke("issue_write", { owner: "CLDMV", repo: "x", title: "t" }, h.ctx());
		await h.broker.invoke("pull_request_read", { owner: "CLDMV", repo: "x", pullNumber: 1 }, h.ctx());
		expect(h.requests).toEqual([
			{ person: "tester", owner: "cldmv", mode: "write", kind: "github" },
			{ person: "tester", owner: "cldmv", mode: "read", kind: "github" }
		]);
	});

	it("a null token fails closed: typed no-access, nothing forwarded, no token anywhere", async () => {
		const h = host();
		const ctx = h.ctx({ resolveToken: vi.fn(async () => null) });
		await expect(h.broker.invoke("pull_request_read", { owner: "cldmv" }, ctx)).rejects.toSatisfy((err: unknown) => {
			expect(err).toBeInstanceOf(InvokeError);
			expect((err as InvokeError).code).toBe("no-access");
			expect((err as Error).message).not.toContain("token:");
			return true;
		});
		expect(h.upstream.forward).not.toHaveBeenCalled();
	});

	it("the daemon's output contract: the result is the dispatch's own object with mcpTarget beside it — no content blocks built here", async () => {
		const h = host();
		const upstreamResult = { content: [{ type: "text", text: "pr data" }] };
		h.upstream.forward.mockResolvedValue(upstreamResult);
		const out = await h.broker.invoke("pull_request_read", { owner: "cldmv" }, h.ctx());
		// byte-for-byte the upstream's result object, not re-wrapped by the library
		expect(out.result).toBe(upstreamResult);
		expect(out.mcpTarget).toBe("pull_request_read");
	});
});
