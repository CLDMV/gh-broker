import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { Router } from "../src/router.ts";
import { OtpRefusal } from "../src/types.ts";
import { unavailableReason } from "../src/availability.ts";
import { GhcrService } from "../src/verbs/ghcr_push.ts";
import { DEFAULT_MAX_ARCHIVE_BYTES } from "../src/verbs/ghcr/config.ts";
import { FakeRegistry, ociArchive, scratchDir, removeDir, join } from "./helpers/ghcr-fixtures.mts";

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

describe("the Router dispatches ghcr_* through the injected GhcrVerbs seam (design #175 §2f)", () => {
	let secrets: { resolve: ReturnType<typeof vi.fn>; has: ReturnType<typeof vi.fn> };
	let upstream: { forward: ReturnType<typeof vi.fn> };
	let logLines: string[];

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logLines.push(a.join(" ")));
		logLines = [];
		secrets = { resolve: vi.fn((ref: string) => `token:${ref}`), has: vi.fn(() => true) };
		upstream = { forward: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }) };
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function ghcrConfig(): any {
		return makeConfig({
			tools: [
				{ name: "ghcr_push", mode: "write" },
				{ name: "ghcr_push_status", mode: "read" },
				{ name: "ghcr_tags", mode: "read" }
			],
			ghcr: { dropDir: "/drop", owners: { alpha: { username: "u", credential: "cred:alpha-ghcr", images: ["hoot"] } } },
			// no config.otp: the default gate stays inert and never touches a state file
			otp: undefined
		});
	}

	/** A GhcrVerbs implementation the daemon never built — the seam must accept it. */
	function fakeGhcr(log: string[]) {
		return {
			push: async (input: unknown) => {
				log.push(`push:${JSON.stringify(input)}`);
				return { job: "j-1", state: "queued" };
			},
			status: (input: unknown) => {
				log.push(`status:${JSON.stringify(input)}`);
				return { jobs: [] };
			},
			tags: async (input: unknown) => {
				log.push(`tags:${JSON.stringify(input)}`);
				return { image: "x", exists: false, tags: [] };
			}
		};
	}

	it("ghcr_push / ghcr_push_status / ghcr_tags reach the injected verbs, results JSON-wrapped", async () => {
		const log: string[] = [];
		const r = new Router(ghcrConfig(), secrets as any, upstream as any, undefined, undefined, fakeGhcr(log));
		const push = await r.call("ghcr_push", { owner: "Alpha", image: "hoot", tag: "1.0.0", archive: "/drop/a.tar" }, { user: "tester" });
		expect(JSON.parse((push.content as { text: string }[])[0]!.text)).toEqual({ job: "j-1", state: "queued" });
		const status = await r.call("ghcr_push_status", { owner: "Alpha" }, { user: "tester" });
		expect(JSON.parse((status.content as { text: string }[])[0]!.text)).toEqual({ jobs: [] });
		const tags = await r.call("ghcr_tags", { owner: "Alpha", image: "hoot" }, { user: "tester" });
		expect(JSON.parse((tags.content as { text: string }[])[0]!.text)).toEqual({ image: "x", exists: false, tags: [] });
		expect(log).toEqual([
			'push:{"owner":"Alpha","image":"hoot","tag":"1.0.0","archive":"/drop/a.tar"}',
			'status:{"owner":"Alpha"}',
			'tags:{"owner":"Alpha","image":"hoot"}'
		]);
		const row = JSON.parse(logLines.find((l) => l.includes('"tool":"ghcr_push"'))!);
		expect(row).toMatchObject({ tool: "ghcr_push", user: "tester", owner: "alpha", repo: "alpha/hoot", decision: "custom", ok: true });
	});

	it("a ghcr verb failure carries the error detail on the call row", async () => {
		const r = new Router(ghcrConfig(), secrets as any, upstream as any, undefined, undefined, {
			push: async () => {
				throw new Error("boom");
			},
			status: () => ({}),
			tags: async () => ({})
		});
		await expect(r.call("ghcr_push", { owner: "Alpha", image: "hoot", tag: "1.0.0", archive: "/drop/a.tar" }, { user: "tester" })).rejects.toThrow("boom");
		const row = JSON.parse(logLines.find((l) => l.includes('"tool":"ghcr_push"'))!);
		expect(row).toMatchObject({ tool: "ghcr_push", decision: "custom", ok: false, detail: "boom" });
	});
});

describe("GhcrService reports the async completion row through the injected onJobDone (design #175 §2f)", () => {
	it("the daemon's callback receives today's exact completion row, and the enqueue row still comes only on successful submit", async () => {
		const logs: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
		const root = scratchDir("s4-onjobdone");
		const drop = join(root, "drop");
		mkdirSync(drop, { recursive: true });
		const reg = new FakeRegistry();
		const base = await reg.start();
		const onJobDone = vi.fn();
		try {
			const svc = new GhcrService(
				{
					dropDir: drop,
					protectReleaseTags: true,
					maxArchiveBytes: DEFAULT_MAX_ARCHIVE_BYTES,
					owners: { cldmv: { username: "Shinrai", credential: "cred:cldmv-packages", images: ["hoot"] } }
				},
				{ resolve: (ref: string) => (ref === "cred:cldmv-packages" ? "ghp_testPatValue0123456789abcdefABCDEF" : "x"), has: () => true } as any,
				{ base, onJobDone }
			);
			const img = ociArchive();
			const archive = join(drop, "img.tar");
			writeFileSync(archive, img.archive);
			const job = await svc.push({ owner: "cldmv", image: "hoot", tag: "1.0.0", archive });
			await svc.queue.idle();
			// The enqueue row: synchronous, only on successful submit, written by the service.
			const enqueue = logs.filter((l) => l.includes('"tool":"ghcr_push"'));
			expect(enqueue).toHaveLength(1);
			expect(JSON.parse(enqueue[0]!)).toMatchObject({ tool: "ghcr_push", owner: "cldmv", mode: "write", decision: "custom", ok: true });
			expect(JSON.parse(enqueue[0]!).detail).toContain(`job=${job.job} queued tag=1.0.0`);
			// The completion row: async, from the job's finally, through the injected callback.
			expect(onJobDone).toHaveBeenCalledTimes(1);
			const row = onJobDone.mock.calls[0]![0] as Record<string, unknown>;
			expect(row).toMatchObject({ tool: "ghcr_push", owner: "cldmv", mode: "write", repo: `${new URL(base).host}/cldmv/hoot`, decision: "custom", ok: true });
			expect(String(row.detail)).toContain(`job=${job.job} tag=1.0.0 digest=`);
			expect(String(row.detail)).toContain(`archive=${archive}`);
			// The injected sink replaced the default: the completion row did NOT also go to audit().
			expect(logs).toHaveLength(1);
		} finally {
			logSpy.mockRestore();
			await reg.stop();
			removeDir(root);
		}
	});
});

describe("unavailableReason takes the injected capability predicate (design #175 §2a)", () => {
	const config = (over: Record<string, unknown> = {}): any => ({
		listen: "unix:/x.sock",
		upstream: "https://api.githubcopilot.com/mcp/",
		tools: [],
		owners: {},
		npm: { token: "cred:npm-token", scopes: ["@cldmv"] },
		ghcr: { dropDir: "/d", owners: { alpha: { username: "u", credential: "cred:alpha-ghcr", images: ["hoot"] } } },
		...over
	});
	const rule = (name: string, extra: Record<string, unknown> = {}) => ({ name, mode: "write", ...extra }) as any;

	it("an unstored npm credential hides npm_scaffold, exactly as before", () => {
		const has = (ref: string) => ref !== "cred:npm-token";
		expect(unavailableReason(rule("npm_scaffold"), config(), has, () => undefined)).toBe(
			'its credential "npm-token" is not stored (re-run the installer with --npm)'
		);
	});

	it("an unstored ghcr credential hides the ghcr verbs, exactly as before", () => {
		expect(unavailableReason(rule("ghcr_push"), config(), () => false, () => undefined)).toBe(
			'no GHCR credential is stored ("alpha-ghcr"; re-run the installer to add one)'
		);
	});

	it("a gated tool is hidden by the injected otpProblem (the host's seed-decoding check)", () => {
		expect(unavailableReason(rule("merge_pull_request"), config(), () => true, () => "OTP is not set up")).toBe("OTP is not set up");
	});

	it("credentials stored + OTP ready → available", () => {
		expect(unavailableReason(rule("ghcr_push"), config(), () => true, () => undefined)).toBeUndefined();
	});
});
