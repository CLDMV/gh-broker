import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Router } from "../src/router.ts";
import { OtpRefusal } from "../src/types.ts";

// Pins for the Router's injected seams (design #175 §2e/§2f): the Router consumes the
// OtpGate INTERFACE, not the concrete daemon class — a foreign implementation passed
// through the unchanged constructor is what the call path dispatches through.

function makeConfig(overrides: Record<string, unknown> = {}): any {
	return {
		listen: "unix:/x.sock",
		upstream: "https://api.githubcopilot.com/mcp/",
		tools: [
			{ name: "get_me", mode: "read" },
			{ name: "merge_pull_request", mode: "write", otp: true },
			{ name: "otp_status", mode: "read", custom: true }
		],
		owners: { alpha: { read: "cred:alpha-read", write: "cred:alpha-write" } },
		otp: { seed: "cred:otp-seed" },
		...overrides
	};
}

/** A gate implementation the daemon never built — the seam must accept it. */
function fakeGate(log: string[], refusal?: OtpRefusal) {
	return {
		enabled: true,
		hardLockRefusal: (user: string) => refusal,
		authorize: (tool: string, code: unknown, user: string) => {
			log.push(`authorize:${tool}:${user}:${String(code)}`);
			return { otp: "opened" as const, window: "w-1", until: "2026-01-01T00:05:00.000Z" };
		},
		status: (user: string) => ({ user, ok: true })
	};
}

describe("the Router dispatches through the injected OtpGate seam (design #175 §2e)", () => {
	let secrets: { resolve: ReturnType<typeof vi.fn>; has: ReturnType<typeof vi.fn> };
	let upstream: { forward: ReturnType<typeof vi.fn> };
	let logLines: string[];

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logLines.push(a.join(" ")));
		logLines = [];
		secrets = { resolve: vi.fn((ref: string) => (ref === "cred:otp-seed" ? "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" : `token:${ref}`)), has: vi.fn(() => true) };
		upstream = { forward: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }) };
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("a gated call is authorized by the injected gate, with the stripped code, and its audit fields land on the call row", async () => {
		const log: string[] = [];
		const r = new Router(makeConfig(), secrets as any, upstream as any, undefined, fakeGate(log));
		await r.call("merge_pull_request", { owner: "Alpha", repo: "thing", otp: "123456" }, { user: "tester" });
		expect(log).toEqual(["authorize:merge_pull_request:tester:123456"]);
		// the otp argument never reaches the upstream
		expect(upstream.forward).toHaveBeenCalledWith("merge_pull_request", { owner: "Alpha", repo: "thing" }, "token:cred:alpha-write");
		const row = JSON.parse(logLines.find((l) => l.includes('"decision":"forward"'))!);
		expect(row).toMatchObject({ tool: "merge_pull_request", otp: "opened", window: "w-1", until: "2026-01-01T00:05:00.000Z" });
	});

	it("otp_status is answered by the injected gate's status()", async () => {
		const log: string[] = [];
		const r = new Router(makeConfig(), secrets as any, upstream as any, undefined, fakeGate(log));
		const out = await r.call("otp_status", {}, { user: "tester" });
		expect(JSON.parse((out.content as { text: string }[])[0]!.text)).toEqual({ user: "tester", ok: true });
		const row = JSON.parse(logLines.find((l) => l.includes('"decision":"custom"'))!);
		expect(row).toMatchObject({ tool: "otp_status", ok: true });
	});

	it("the injected gate's hardLockRefusal blocks every tool except otp_status", async () => {
		const refusal = new OtpRefusal("hard locked", { otp: "hard-locked" });
		const log: string[] = [];
		const r = new Router(makeConfig(), secrets as any, upstream as any, undefined, fakeGate(log, refusal));
		await expect(r.call("get_me", { owner: "Alpha" }, { user: "tester" })).rejects.toBe(refusal);
		expect(upstream.forward).not.toHaveBeenCalled();
		const row = JSON.parse(logLines.find((l) => l.includes('"decision":"deny"'))!);
		expect(row).toMatchObject({ tool: "get_me", decision: "deny", detail: "otp hard lock", otp: "hard-locked" });
		// otp_status still answers under a hard lock
		const out = await r.call("otp_status", {}, { user: "tester" });
		expect(out.content).toBeDefined();
	});
});
