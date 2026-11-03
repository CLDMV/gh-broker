import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

const { npmScaffoldMock } = vi.hoisted(() => ({ npmScaffoldMock: vi.fn() }));
vi.mock("../src/verbs/npm_scaffold.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/verbs/npm_scaffold.ts")>()),
	npmScaffold: npmScaffoldMock
}));

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Router } from "../src/router.ts";
import { OtpGate } from "../src/otp/gate.ts";
import { base32Encode, totpAt } from "../src/otp/totp.ts";
import { emptyState, emptyUser } from "../src/otp/state.ts";

const KEY = Buffer.from("12345678901234567890", "ascii");
const SEED = base32Encode(KEY);
const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const ROOT = join(process.cwd(), "tmp", "otp-router-tests");
let n = 0;

const TOOLS = [
	{ name: "get_me", mode: "read" },
	{ name: "merge_pull_request", mode: "write", otp: true },
	{ name: "create_pull_request", mode: "write" },
	{ name: "npm_scaffold", mode: "write", custom: true, otp: true },
	{ name: "otp_status", mode: "read", custom: true },
	{ name: "create_repository", mode: "write" },
	{ name: "fork_repository", mode: "write" },
	{ name: "update_pull_request_branch", mode: "write" },
	{ name: "actions_run_trigger", mode: "write" }
];

function setup(opts: { otp?: Record<string, unknown> | null; seedStored?: boolean } = {}) {
	const dir = join(ROOT, `case-${n++}`);
	mkdirSync(dir, { recursive: true });
	const statePath = join(dir, "state.json");
	const config: any = {
		listen: "agents:/run/gh-broker/agents",
		upstream: "https://api.githubcopilot.com/mcp/",
		tools: TOOLS,
		owners: { cldmv: { read: "cred:cldmv-read", write: "cred:cldmv-write" } },
		npm: { token: "cred:npm-token", scopes: ["@cldmv"] },
		...(opts.otp === null ? {} : { otp: { seed: "cred:otp-seed", statePath, ...opts.otp } })
	};
	const seedStored = opts.seedStored ?? true;
	const secrets = {
		resolve: vi.fn((ref: string) => (ref === "cred:otp-seed" ? SEED : `token:${ref}`)),
		has: vi.fn((ref: string) => ref !== "cred:otp-seed" || seedStored)
	};
	const upstream = { forward: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }) };
	const clock = { t: T0 };
	const gate = new OtpGate(config, secrets as any, { now: () => clock.t, host: "box" });
	const router = new Router(config, secrets as any, upstream as any, undefined, gate);
	const call = (tool: string, args: Record<string, unknown>, user = "repo") => router.call(tool, args, { user });
	return { router, call, upstream, secrets, clock, statePath, code: () => totpAt(KEY, clock.t) };
}

let logs: string[];
beforeEach(() => {
	vi.clearAllMocks();
	logs = [];
	vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
});
afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

const lastAudit = () => JSON.parse(logs[logs.length - 1]!);

describe("Router + OTP gate: new tools (#146)", () => {
	it("gates create_repository by default and runs it on the write PAT of the org the repo lands in", async () => {
		const h = setup();
		await expect(h.call("create_repository", { name: "x", organization: "CLDMV", private: true })).rejects.toThrow(/OTP required for create_repository/);
		expect(h.upstream.forward).not.toHaveBeenCalled();
		await h.call("create_repository", { name: "x", organization: "CLDMV", private: false, otp: h.code() });
		expect(h.upstream.forward).toHaveBeenCalledWith("create_repository", { name: "x", organization: "CLDMV", private: false }, "token:cred:cldmv-write");
		expect(lastAudit()).toMatchObject({ tool: "create_repository", owner: "cldmv", repo: "cldmv/x", decision: "forward", ok: true, otp: "opened" });
	});

	it("refuses a repo with no organization or no explicit private before the gate, so no code is spent or counted", async () => {
		const h = setup();
		const c = h.code();
		await expect(h.call("create_repository", { name: "x", private: true, otp: c })).rejects.toThrow(/"organization" is required .* personal account/);
		await expect(h.call("create_repository", { name: "x", organization: "cldmv", otp: c })).rejects.toThrow(/"private" is required, true or false/);
		await expect(h.call("fork_repository", { owner: "someone", repo: "y", otp: c })).rejects.toThrow(/"organization" is required/);
		await expect(h.call("create_repository", { name: "x", organization: "OtherOrg", private: true, otp: c })).rejects.toThrow(/no credentials configured for owner "otherorg"/);
		await expect(h.call("actions_run_trigger", { owner: "cldmv", repo: "x", method: "delete_workflow_run_logs", run_id: 1, otp: c })).rejects.toThrow(/"delete_workflow_run_logs" is not allowed in gh-broker/);
		expect(lastAudit()).toMatchObject({ tool: "actions_run_trigger", decision: "error" });
		expect(lastAudit().otp).toBeUndefined();
		expect(h.upstream.forward).not.toHaveBeenCalled();
		// The code is still unspent: it opens a window now.
		await h.call("fork_repository", { owner: "someone", repo: "y", organization: "CLDMV", otp: c });
		expect(h.upstream.forward).toHaveBeenCalledWith("fork_repository", { owner: "someone", repo: "y", organization: "CLDMV" }, "token:cred:cldmv-write");
		expect(lastAudit()).toMatchObject({ owner: "cldmv", repo: "cldmv/y", source: "someone/y", otp: "opened" });
		// Other actions_run_trigger methods go through the gate as usual.
		await h.call("actions_run_trigger", { owner: "cldmv", repo: "x", method: "rerun_failed_jobs", run_id: 1, otp: c });
		expect(h.upstream.forward).toHaveBeenLastCalledWith("actions_run_trigger", { owner: "cldmv", repo: "x", method: "rerun_failed_jobs", run_id: 1 }, "token:cred:cldmv-write");
		expect(lastAudit()).toMatchObject({ tool: "actions_run_trigger", otp: "window" });
	});

	it("leaves update_pull_request_branch ungated", async () => {
		const h = setup();
		await h.call("update_pull_request_branch", { owner: "cldmv", repo: "x", pullNumber: 3 });
		expect(h.upstream.forward).toHaveBeenCalledWith("update_pull_request_branch", { owner: "cldmv", repo: "x", pullNumber: 3 }, "token:cred:cldmv-write");
	});
});

describe("Router + OTP gate", () => {
	it("runs a gated tool with a valid code, strips otp before forwarding, and audits the window, never the code", async () => {
		const h = setup();
		const c = h.code();
		await h.call("merge_pull_request", { owner: "cldmv", repo: "x", pullNumber: 1, otp: c });
		expect(h.upstream.forward).toHaveBeenCalledWith("merge_pull_request", { owner: "cldmv", repo: "x", pullNumber: 1 }, "token:cred:cldmv-write");
		const opened = lastAudit();
		expect(opened).toMatchObject({ tool: "merge_pull_request", user: "repo", decision: "forward", ok: true, otp: "opened", window: expect.stringMatching(/^[0-9a-f]{16}$/) });

		await h.call("merge_pull_request", { owner: "cldmv", repo: "x", pullNumber: 2, otp: c });
		expect(lastAudit()).toMatchObject({ otp: "window", window: opened.window });
		for (const line of logs) expect(line).not.toContain(c);
	});

	it("refuses a gated call with no code: nothing forwarded, audited as refused", async () => {
		const h = setup();
		await expect(h.call("merge_pull_request", { owner: "cldmv", repo: "x" })).rejects.toThrow(
			'OTP required for merge_pull_request: ask the user for a current code from their authenticator app and pass it as "otp". Nothing was run.'
		);
		expect(h.upstream.forward).not.toHaveBeenCalled();
		expect(lastAudit()).toMatchObject({ tool: "merge_pull_request", decision: "deny", otp: "refused" });
	});

	it("audits a gated call whose dispatch fails with its otp fields", async () => {
		const h = setup();
		h.upstream.forward.mockRejectedValueOnce(new Error("boom"));
		await expect(h.call("merge_pull_request", { owner: "cldmv", repo: "x", otp: h.code() })).rejects.toThrow("boom");
		expect(lastAudit()).toMatchObject({ ok: false, detail: "boom", otp: "opened" });
	});

	it("a gated npm_scaffold call carries both codes: otp is stripped, npm_otp reaches the verb", async () => {
		const h = setup();
		npmScaffoldMock.mockResolvedValue({ status: "done" });
		const c = h.code();
		const out = await h.call("npm_scaffold", { owner: "cldmv", repo: "x", package: "@cldmv/x", npm_otp: "654321", otp: c });
		expect(JSON.parse((out.content[0] as any).text)).toEqual({ status: "done" });
		expect(npmScaffoldMock).toHaveBeenCalledTimes(1);
		expect(npmScaffoldMock.mock.calls[0]![0]).toEqual({ owner: "cldmv", repo: "x", package: "@cldmv/x", npm_otp: "654321" });
		expect(lastAudit()).toMatchObject({ tool: "npm_scaffold", decision: "custom", ok: true, otp: "opened" });
	});

	it("an ungated tool behaves as before: args forwarded byte-identical once otp is stripped, no otp audit fields", async () => {
		const h = setup();
		const args = { owner: "cldmv", repo: "x", title: "t", nested: { a: [1, 2] } };
		await h.call("create_pull_request", { ...args, otp: "123456" });
		expect(JSON.stringify(h.upstream.forward.mock.calls[0]![1])).toBe(JSON.stringify(args));
		await h.call("create_pull_request", args);
		expect(h.upstream.forward.mock.calls[1]![1]).toBe(args); // untouched object when there is nothing to strip
		expect(lastAudit()).not.toHaveProperty("otp");
		expect(lastAudit()).not.toHaveProperty("window");
	});

	it("without config.otp, ungated tools still have otp stripped and no state file is involved", async () => {
		const h = setup({ otp: null });
		await h.call("get_me", { owner: "cldmv", otp: "1" });
		expect(h.upstream.forward).toHaveBeenCalledWith("get_me", { owner: "cldmv" }, "token:cred:cldmv-read");
	});

	it("hides and refuses gated tools while OTP isn't set up, but otp_status still answers", async () => {
		for (const h of [setup({ otp: null }), setup({ seedStored: false })]) {
			expect(h.router.advertisedTools().map((t) => t.name)).toEqual(["get_me", "create_pull_request", "otp_status", "update_pull_request_branch"]);
			await expect(h.call("merge_pull_request", { owner: "cldmv", otp: "123456" })).rejects.toThrow(
				/tool "merge_pull_request" is not available on this broker: OTP is not set up on this broker.*re-run the installer/
			);
			const status = JSON.parse(((await h.call("otp_status", {})).content[0] as any).text);
			expect(status).toMatchObject({ configured: false, gatedTools: ["merge_pull_request", "npm_scaffold", "create_repository", "fork_repository", "actions_run_trigger"] });
		}
	});

	it("a user's hard lock blocks every tool for that user, ungated ones too, except otp_status; others carry on", async () => {
		const h = setup();
		writeFileSync(h.statePath, JSON.stringify({ ...emptyState(), users: { repo: { ...emptyUser(), hardLock: { since: "2026-11-01T11:00:00.000Z", lockouts: 3 } } } }));
		const msg = 'gh-broker is locked for repo after repeated bad OTP codes (since 2026-11-01T11:00:00.000Z). Ask the user to run "sudo gh-broker otp unlock repo" on box. Nothing was run.';
		await expect(h.call("get_me", { owner: "cldmv" })).rejects.toThrow(msg);
		expect(lastAudit()).toMatchObject({ tool: "get_me", user: "repo", decision: "deny", otp: "hard-locked" });
		await expect(h.call("merge_pull_request", { owner: "cldmv", otp: h.code() })).rejects.toThrow(msg);
		expect(h.upstream.forward).not.toHaveBeenCalled();

		const status = JSON.parse(((await h.call("otp_status", { otp: "123456" })).content[0] as any).text);
		expect(status).toMatchObject({
			configured: true,
			user: "repo",
			hardLock: { since: "2026-11-01T11:00:00.000Z", lockouts: 3 },
			unlockCommand: "sudo gh-broker otp unlock repo",
			lockedUsers: [{ user: "repo", since: "2026-11-01T11:00:00.000Z", lockouts: 3, unlockCommand: "sudo gh-broker otp unlock repo" }],
			host: "box"
		});
		expect(lastAudit()).toMatchObject({ tool: "otp_status", user: "repo", decision: "custom", ok: true });

		await h.call("get_me", { owner: "cldmv" }, "glmtest");
		await h.call("merge_pull_request", { owner: "cldmv", otp: h.code() }, "glmtest");
		expect(h.upstream.forward).toHaveBeenCalledTimes(2);
		expect(lastAudit()).toMatchObject({ user: "glmtest", otp: "opened" });
		const other = JSON.parse(((await h.call("otp_status", {}, "glmtest")).content[0] as any).text);
		expect(other).toMatchObject({ user: "glmtest", hardLock: null, lockedUsers: [{ user: "repo" }] });
	});

	it("a window opened by one user is refused for another, even with the same code", async () => {
		const h = setup();
		const c = h.code();
		await h.call("merge_pull_request", { owner: "cldmv", otp: c }, "repo");
		await expect(h.call("merge_pull_request", { owner: "cldmv", otp: c }, "glmtest")).rejects.toThrow(/OTP required for merge_pull_request/);
		expect(lastAudit()).toMatchObject({ user: "glmtest", decision: "deny", otp: "refused" });
		expect(h.upstream.forward).toHaveBeenCalledTimes(1);
	});

	it("a corrupt state file fails closed for every tool but otp_status", async () => {
		const h = setup();
		writeFileSync(h.statePath, "garbage");
		await expect(h.call("get_me", { owner: "cldmv" })).rejects.toThrow(/gh-broker is locked for every agent: its OTP state file is unreadable or corrupt .*"sudo gh-broker otp unlock --all"/);
		await expect(h.call("otp_status", {})).resolves.toBeDefined();
	});

	it("a short lockout refuses gated tools only", async () => {
		const h = setup({ otp: { maxFailures: 1 } });
		await expect(h.call("merge_pull_request", { owner: "cldmv", otp: "000000" })).rejects.toThrow(/OTP required/);
		await expect(h.call("merge_pull_request", { owner: "cldmv", otp: h.code() })).rejects.toThrow("OTP is locked for 10 more minute(s) after too many bad codes. Nothing was run.");
		expect(lastAudit()).toMatchObject({ otp: "locked" });
		await expect(h.call("get_me", { owner: "cldmv" })).resolves.toBeDefined();
	});

	it("otp_status output never carries a code or the seed", async () => {
		const h = setup();
		const c = h.code();
		await h.call("merge_pull_request", { owner: "cldmv", otp: c });
		const text = ((await h.call("otp_status", {})).content[0] as any).text as string;
		expect(JSON.parse(text)).toMatchObject({ openWindows: 1 });
		expect(text).not.toContain(c);
		expect(text).not.toContain(SEED);
	});

	it("builds its own gate when none is injected", async () => {
		const h = setup({ otp: null });
		const r = new Router({ ...(h.router as any).config }, h.secrets as any, h.upstream as any);
		const status = JSON.parse(((await r.call("otp_status", {}, { user: "repo" })).content[0] as any).text);
		expect(status.configured).toBe(false);
	});
});
