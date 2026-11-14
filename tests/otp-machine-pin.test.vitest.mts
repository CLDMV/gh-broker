/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /tests/otp-machine-pin.test.vitest.mts
 *	@Date: 2026-11-13T21:30:00-08:00 (1794706200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-13T21:30:00-08:00 (1794706200)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OtpGate, OtpRefusal, machineConfig, otpAuditRow } from "../src/otp/gate.ts";
import { otpSettings } from "../src/otp/policy.ts";
import { base32Encode, hotp, stepAt, totpAt } from "../src/otp/totp.ts";
import { DEFAULTS, emptyPerson, formatStatus as libFormatStatus, parseOtpOptions, spendThrough, stepOtp } from "@cldmv/lib-otp";
import { emptyState, emptyUser, personOf, secondsUntilFreshCode, spendRecentCodes } from "../src/otp/state.ts";
import * as cliOtp from "../src/cli/otp.ts";
import { otpCommand } from "../src/cli/otp-cli.ts";
import { NOW, config, makeDeps } from "./helpers/cli-deps.mts";

// Pins for the lib-otp adoption (design #175 slice 2): the gate is host code over the
// package's machine, and these pin the host-side contract that the machine tests can't —
// the machine-config mapping, the reason-code → audit-row table, windows never reaching
// disk, the LockStateStore write-failure contract, the monotonic global-step threading,
// the per-person window scoping, and the CLI's spend via the package's spendThrough.

const KEY = Buffer.from("12345678901234567890", "ascii");
const SEED = base32Encode(KEY);
const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const MIN = 60_000;
const TOOL = "merge_pull_request";

const ROOT = join(process.cwd(), "tmp", "otp-machine-pin-tests");
let n = 0;

function harness(otp: Record<string, unknown> = {}, seed = SEED) {
	const dir = join(ROOT, `case-${n++}`);
	mkdirSync(dir, { recursive: true });
	const clock = { t: T0 };
	const secrets = { has: vi.fn(() => seed !== ""), resolve: vi.fn(() => seed) };
	const config = {
		listen: "agents:/run/gh-broker/agents",
		upstream: "https://api.githubcopilot.com/mcp/",
		owners: { cldmv: { read: "cred:r", write: "cred:w" } },
		tools: [{ name: TOOL, mode: "write", otp: true }],
		otp: { seed: "cred:otp-seed", statePath: join(dir, "state.json"), ...otp }
	};
	const gate = new OtpGate(config as any, secrets as any, { now: () => clock.t, host: "box" });
	const code = (at = clock.t) => totpAt(KEY, at);
	const statePath = join(dir, "state.json");
	const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
	const auth = (c: unknown, user = "repo") => gate.authorize(TOOL, c, user);
	return { dir, clock, gate, code, statePath, readState, auth };
}

/** Run fn and return the OtpRefusal it throws. */
function refusal(fn: () => unknown): OtpRefusal {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(OtpRefusal);
		return err as OtpRefusal;
	}
	throw new Error("expected a refusal");
}

const SPENT = /^OTP code for merge_pull_request is spent \(it, or a newer code, was already used\): ask the user for the next code from their authenticator app and pass it as "otp"\. Nothing was run\.$/;
const UNSAVED = "OTP could not be checked: the broker could not save its OTP state. Nothing was run.";

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
});
afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

describe("the daemon's machine config (the explicit §2g mapping)", () => {
	it("maps the defaults and is accepted by parseOtpOptions", () => {
		const mapped = machineConfig(otpSettings({} as any));
		expect(mapped).toEqual(
			parseOtpOptions({
				digits: 6,
				periodSeconds: 30,
				algorithm: "SHA1",
				skewSteps: 1,
				windowSeconds: 300,
				maxFailures: 5,
				failureCounting: { mode: "since-accept-or-lockout" },
				lockoutSeconds: 600,
				lockoutEscalation: { factor: 1, maxSeconds: 600 },
				spendOnUnlock: true,
				hardLockEnabled: true,
				hardLockTrigger: { lockouts: 3, windowMs: 86_400_000 },
				refuseReused: true,
				windowEnabled: true
			})
		);
	});

	it("maps every knob config.otp accepts, and parseOtpOptions accepts them all", () => {
		const settings = otpSettings({ otp: { windowSeconds: 60, maxFailures: 2, lockoutSeconds: 30, maxLockouts: 9 } } as any);
		expect(machineConfig(settings)).toEqual(
			parseOtpOptions({
				digits: 6,
				periodSeconds: 30,
				algorithm: "SHA1",
				skewSteps: 1,
				windowSeconds: 60,
				maxFailures: 2,
				failureCounting: { mode: "since-accept-or-lockout" },
				lockoutSeconds: 30,
				lockoutEscalation: { factor: 1, maxSeconds: 30 },
				spendOnUnlock: true,
				hardLockEnabled: true,
				hardLockTrigger: { lockouts: 9, windowMs: 86_400_000 },
				refuseReused: true,
				windowEnabled: true
			})
		);
	});
});

describe("the reason-code → audit-row table", () => {
	const CMD = "sudo gh-broker otp unlock repo";
	const opts = { maxFailures: 5, unlockCommand: CMD };
	const machine = parseOtpOptions();

	const outcomeOf = (reason: string, over: Record<string, unknown> = {}) => {
		// Build each outcome through the machine itself, so the pin runs against real shapes.
		switch (reason) {
			case "bad-code":
				return stepOtp(emptyPerson(), { kind: "code-bad", now: T0 }, machine).outcome!;
			case "locked-out":
				return stepOtp(emptyPerson(), { kind: "code-bad", now: T0 }, parseOtpOptions({ maxFailures: 1 })).outcome!;
			case "hard-locked-now":
				return stepOtp(emptyPerson(), { kind: "code-bad", now: T0 }, parseOtpOptions({ maxFailures: 1, hardLockTrigger: { lockouts: 1, windowMs: 86_400_000 } })).outcome!;
			default:
				return { reason, ...over };
		}
	};

	it("locked-out → today's otp lockout row", () => {
		const outcome = outcomeOf("locked-out");
		expect(outcome).toMatchObject({ reason: "locked-out" });
		expect(otpAuditRow(TOOL, "repo", outcome, opts)).toEqual({ tool: TOOL, user: "repo", decision: "deny", otp: "lockout", until: (outcome as any).until, detail: "5 bad codes" });
	});

	it("hard-locked-now → today's otp hard-lock row (one row, replacing the lockout)", () => {
		const outcome = outcomeOf("hard-locked-now");
		expect(outcome).toMatchObject({ reason: "hard-locked-now" });
		expect(otpAuditRow(TOOL, "repo", outcome, opts)).toEqual({
			tool: TOOL,
			user: "repo",
			decision: "deny",
			otp: "hard-lock",
			detail: `1 lockouts in 24 h; every tool except otp_status is refused until "${CMD}"`
		});
	});

	it("every other outcome writes no extra row", () => {
		for (const outcome of [outcomeOf("bad-code"), outcomeOf("spent-code"), outcomeOf("window"), outcomeOf("opened", { counter: 1, window: "w", expiresAt: null }), outcomeOf("locked", { until: "x" }), outcomeOf("hard-locked", { since: "x" })]) {
			expect(otpAuditRow(TOOL, "repo", outcome, opts)).toBeUndefined();
		}
	});
});

describe("windows never reach disk", () => {
	it("the file-bytes-after-write pin: an open window's record carries no windows key", () => {
		const h = harness();
		const iso = new Date(T0 - MIN).toISOString();
		writeFileSync(h.statePath, JSON.stringify({ ...emptyState(), users: { repo: { ...emptyUser(), lockouts: [iso] } } }));
		const opened = h.auth(h.code());
		expect(opened.otp).toBe("opened");
		// The gate's map holds the window...
		expect(h.gate.status("repo")).toMatchObject({ openWindows: 1 });
		// ...but the file record does not: windows (and the machine's other memory-tier
		// fields) are stripped from every write.
		const written = h.readState();
		expect(Object.hasOwn(written.users.repo, "windows")).toBe(false);
		expect(written.users.repo).toEqual({ failures: 0, lockedUntil: null, lockouts: [iso], hardLock: null });
		expect(JSON.stringify(written)).not.toContain("windows");
	});
});

describe("the monotonic global-step threading", () => {
	it("a failed accept write still advances the global, so another user's code at that step is spent", () => {
		const h = harness({ statePath: join(ROOT, `threading-${n++}`, "state.json") });
		const c = h.code();
		// repo's accept can't be saved: refused, and no window is opened.
		expect(refusal(() => h.auth(c)).message).toBe(UNSAVED);
		expect(h.gate.status("repo")).toMatchObject({ openWindows: 0 });
		// The step is spent for glmtest anyway: the in-memory global advanced with the write.
		expect(refusal(() => h.auth(c, "glmtest")).message).toMatch(SPENT);
		expect(h.gate.status("glmtest")).toMatchObject({ failures: 0, openWindows: 0 });
	});
});

describe("the per-person window map", () => {
	it("user B cannot open or reuse a window with user A's code", () => {
		const h = harness();
		const c = h.code();
		const opened = h.auth(c, "repo");
		// glmtest sending repo's code: not glmtest's window, and the code is spent for everyone.
		expect(refusal(() => h.auth(c, "glmtest")).message).toMatch(SPENT);
		// No window was recorded for glmtest, and nothing was counted.
		expect(h.gate.status("glmtest")).toMatchObject({ openWindows: 0, failures: 0 });
		// repo's window still serves repo.
		expect(h.auth(c, "repo")).toEqual({ otp: "window", window: opened.window });
	});
});

describe("the CLI's spend runs through the package's spendThrough", () => {
	it("spendThrough at the defaults equals today's floor(now / 30 s) + 1", () => {
		for (const now of [T0, T0 + 29_999, T0 + 30_000, Date.parse("2026-11-01T12:05:10.000Z"), NOW]) {
			expect(spendThrough(now, DEFAULTS)).toBe(Math.floor(now / 30_000) + 1);
		}
	});

	it("spendRecentCodes advances the step through spendThrough and never lowers it", () => {
		const now = Date.parse("2026-11-01T12:05:10.000Z");
		const step = Math.floor(now / 30_000);
		expect(spendRecentCodes(emptyState(), now).lastAcceptedStep).toBe(step + 1);
		expect(spendRecentCodes({ ...emptyState(), lastAcceptedStep: step + 5 }, now).lastAcceptedStep).toBe(step + 5);
	});

	it("secondsUntilFreshCode still counts to the start of the step after next (31-60 s)", () => {
		const now = Date.parse("2026-11-01T12:05:00.000Z");
		const old = (t: number): number => Math.ceil(((Math.floor(t / 30_000) + 2) * 30_000 - t) / 1000);
		for (const t of [now, now + 29_500, T0, T0 + 12_345]) expect(secondsUntilFreshCode(t)).toBe(old(t));
	});

	it("the machine's admin-unlock names today's three outcomes", () => {
		const machine = parseOtpOptions();
		expect(stepOtp(emptyPerson(), { kind: "admin-unlock", by: "root", now: NOW }, machine).outcome).toEqual({ reason: "no-entry" });
		expect(stepOtp(personOf({ ...emptyUser(), failures: 2 }), { kind: "admin-unlock", by: "root", now: NOW }, machine).outcome).toEqual({ reason: "cleared" });
		const unlocked = stepOtp(personOf({ ...emptyUser(), hardLock: { since: "2026-11-01T12:00:00.000Z", lockouts: 3 } }), { kind: "admin-unlock", by: "root", now: NOW }, machine);
		expect(unlocked.outcome).toEqual({ reason: "unlocked" });
		// The post-unlock record keeps the machine's spend and the windows.
		expect(unlocked.state.lastCounter).toBe(Math.floor(NOW / 30_000) + 1);
	});

	it("an unlock of an entry that exists but is all-zero still says cleared (today's wording)", async () => {
		const { d, out } = makeDeps({ readState: () => ({ status: "ok", state: { ...emptyState(), users: { repo: emptyUser() } } }) });
		expect(await otpCommand("unlock", ["repo"], config, d)).toBe(0);
		expect(out[0]).toContain("cleared repo's counters (not hard-locked)");
	});
});

describe("the CLI status rendering over the package's formatters", () => {
	it("each user's block is the package's formatStatus block, byte-identical", () => {
		const hardLock = { since: "2026-11-01T12:00:00.000Z", lockouts: 3 };
		const block = libFormatStatus([{ person: "repo", locked: true, failures: 2, maxFailures: 5, lockedUntil: null, lockoutsInWindow: 3, maxLockouts: 3, hardLock }], {
			configured: true,
			unlockCommand: "sudo gh-broker otp unlock"
		}).slice(1);
		const lines = cliOtp.formatStatus([{ user: "repo", locked: true, failures: 2, maxFailures: 5, lockedUntil: null, lockoutsLast24h: 3, maxLockouts: 3, hardLock }], {
			statePath: "/p",
			fileStatus: "ok",
			configured: true
		});
		expect(lines).toEqual(["OTP configured: yes", "state file: /p (ok)", ...block]);
		expect(block).toEqual(["repo:", "  bad codes so far: 2 of 5", "  short lockouts in the last 24 h: 3 of 3", `  HARD LOCK since 2026-11-01T12:00:00.000Z after 3 lockouts. Clear it with: sudo gh-broker otp unlock repo`]);
	});
});
