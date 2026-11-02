import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { OtpGate, OtpRefusal, UNLOCK_COMMAND, windowText } from "../src/otp/gate.ts";
import { DEFAULT_GATED, OTP_DEFAULTS, isGated, otpSettings, otpSetupProblem, readSeed } from "../src/otp/policy.ts";
import { base32Encode, hotp, stepAt, totpAt } from "../src/otp/totp.ts";
import { emptyState } from "../src/otp/state.ts";

const KEY = Buffer.from("12345678901234567890", "ascii");
const SEED = base32Encode(KEY);
const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const MIN = 60_000;

const ROOT = join(process.cwd(), "tmp", "otp-gate-tests");
let n = 0;

function makeConfig(otp: Record<string, unknown> | null, dir: string): any {
	return {
		listen: "unix:/x",
		upstream: "https://api.githubcopilot.com/mcp/",
		owners: { cldmv: { read: "cred:r", write: "cred:w" } },
		tools: [
			{ name: "merge_pull_request", mode: "write", otp: true },
			{ name: "get_me", mode: "read" },
			{ name: "otp_status", mode: "read", custom: true }
		],
		...(otp ? { otp: { seed: "cred:otp-seed", statePath: join(dir, "state.json"), ...otp } } : {})
	};
}

function harness(otp: Record<string, unknown> | null = {}, seed = SEED) {
	const dir = join(ROOT, `case-${n++}`);
	mkdirSync(dir, { recursive: true });
	const clock = { t: T0 };
	const secrets = { has: vi.fn(() => seed !== ""), resolve: vi.fn(() => seed) };
	const config = makeConfig(otp, dir);
	const make = () => new OtpGate(config, secrets as any, { now: () => clock.t, host: "box" });
	const gate = make();
	const code = (at = clock.t) => totpAt(KEY, at);
	const statePath = join(dir, "state.json");
	const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
	return { dir, clock, secrets, config, gate, make, code, statePath, readState };
}

/** Run authorize and return the refusal it throws. */
function refusal(fn: () => unknown): OtpRefusal {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(OtpRefusal);
		return err as OtpRefusal;
	}
	throw new Error("expected a refusal");
}

const REFUSED = /^OTP required for merge_pull_request: ask the user for a current code from their authenticator app and pass it as "otp"\. Nothing was run\.$/;

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
});
afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

describe("policy", () => {
	it("gates by the rule's own flag, else the (empty) default set, and never otp_status", () => {
		expect(DEFAULT_GATED.size).toBe(0);
		expect(isGated({ name: "x", mode: "write" })).toBe(false);
		expect(isGated({ name: "x", mode: "write", otp: true })).toBe(true);
		expect(isGated({ name: "x", mode: "write", otp: false })).toBe(false);
		expect(isGated({ name: "otp_status", mode: "read", otp: true })).toBe(false);
	});

	it("fills in defaults", () => {
		expect(otpSettings({} as any)).toEqual(OTP_DEFAULTS);
		expect(otpSettings({ otp: { seed: "cred:s", windowSeconds: 60, maxFailures: 2, lockoutSeconds: 30, maxLockouts: 9, statePath: "/s.json" } } as any)).toEqual({
			windowSeconds: 60,
			maxFailures: 2,
			lockoutSeconds: 30,
			maxLockouts: 9,
			statePath: "/s.json"
		});
	});

	it("explains every way OTP can be missing, without revealing the seed", () => {
		const has = (v: boolean) => ({ has: () => v, resolve: () => "!!not base32!!" }) as any;
		expect(otpSetupProblem({} as any, has(true))).toMatch(/OTP is not set up on this broker \(no config\.otp\); re-run the installer/);
		const cfg = { otp: { seed: "cred:otp-seed" } } as any;
		expect(otpSetupProblem(cfg, has(false))).toMatch(/seed credential "otp-seed" is not stored \(re-run the installer/);
		const bad = otpSetupProblem(cfg, has(true));
		expect(bad).toMatch(/stored seed "otp-seed" is not valid base32/);
		expect(bad).not.toContain("not base32!!");
		expect(otpSetupProblem(cfg, { has: () => true, resolve: () => "====" } as any)).toMatch(/not valid base32/);
		expect(otpSetupProblem(cfg, { has: () => true, resolve: () => `${SEED}\n` } as any)).toBeUndefined();
		expect(readSeed(cfg, { has: () => true, resolve: () => SEED } as any)).toEqual({ key: KEY });
	});

	it("windowText", () => {
		expect(windowText(300)).toBe("5 minutes");
		expect(windowText(60)).toBe("1 minute");
		expect(windowText(90)).toBe("90 seconds");
	});
});

describe("OtpGate windows", () => {
	it("opens a window on a valid code and accepts the same code for the whole window, then refuses it", () => {
		const h = harness();
		const c = h.code();
		const opened = h.gate.authorize("merge_pull_request", c);
		expect(opened).toEqual({ otp: "opened", window: expect.stringMatching(/^[0-9a-f]{16}$/) });
		expect(opened.window).not.toContain(c);
		expect(h.readState()).toMatchObject({ lastAcceptedStep: stepAt(T0), failures: 0 });

		h.clock.t = T0 + 5 * MIN - 1;
		expect(h.gate.authorize("merge_pull_request", c)).toEqual({ otp: "window", window: opened.window });

		h.clock.t = T0 + 5 * MIN;
		const r = refusal(() => h.gate.authorize("merge_pull_request", c));
		expect(r.message).toMatch(REFUSED);
		expect(r.audit).toEqual({ otp: "refused" });
		expect(h.readState().failures).toBe(1);
	});

	it("a reused code can't open a second window, even when it is still a valid TOTP", () => {
		const h = harness({ windowSeconds: 10 });
		const c = h.code();
		h.gate.authorize("merge_pull_request", c);
		h.clock.t = T0 + 15_000; // window closed, the code's step is still within ±1
		expect(refusal(() => h.gate.authorize("merge_pull_request", c)).audit.otp).toBe("refused");
	});

	it("a restart closes the windows and the persisted step stops the old code reopening one", () => {
		const h = harness();
		const c = h.code();
		h.gate.authorize("merge_pull_request", c);
		const restarted = h.make();
		expect(refusal(() => restarted.authorize("merge_pull_request", c)).message).toMatch(REFUSED);
		expect(restarted.status()).toMatchObject({ openWindows: 0, failures: 1 });
	});

	it("an older code than the last accepted one is refused", () => {
		const h = harness();
		h.gate.authorize("merge_pull_request", h.code());
		expect(() => h.gate.authorize("merge_pull_request", hotp(KEY, stepAt(T0) - 1))).toThrow(REFUSED);
	});

	it("keeps several windows open at once, one per code", () => {
		const h = harness();
		const a = h.gate.authorize("merge_pull_request", h.code());
		h.clock.t = T0 + 30_000;
		const b = h.gate.authorize("merge_pull_request", h.code());
		expect(b.otp).toBe("opened");
		expect(b.window).not.toBe(a.window);
		expect(h.gate.status()).toMatchObject({ openWindows: 2, nextWindowExpiresAt: new Date(T0 + 5 * MIN).toISOString() });
		expect(h.gate.authorize("merge_pull_request", totpAt(KEY, T0))).toEqual({ otp: "window", window: a.window });
	});

	it("a missing code is refused without counting as a failure", () => {
		const h = harness();
		for (const missing of [undefined, null, ""]) expect(refusal(() => h.gate.authorize("merge_pull_request", missing)).message).toMatch(REFUSED);
		expect(h.gate.status()).toMatchObject({ failures: 0 });
	});

	it("wrong, malformed and non-string codes are refused and counted", () => {
		const h = harness();
		const wrong = String((Number(h.code()) + 1) % 1_000_000).padStart(6, "0");
		for (const bad of [wrong, "12345", "abcdef", 123456]) expect(refusal(() => h.gate.authorize("merge_pull_request", bad)).message).toMatch(REFUSED);
		expect(h.readState().failures).toBe(4);
	});

	it("a valid code resets the failure counter", () => {
		const h = harness();
		expect(() => h.gate.authorize("merge_pull_request", "000000")).toThrow(REFUSED);
		h.gate.authorize("merge_pull_request", h.code());
		expect(h.readState().failures).toBe(0);
	});

	it("refuses to open a window when the state can't be saved", () => {
		const h = harness({ statePath: join(ROOT, "no-such-dir", "state.json") });
		const r = refusal(() => h.gate.authorize("merge_pull_request", h.code()));
		expect(r.message).toBe("OTP could not be checked: the broker could not save its OTP state. Nothing was run.");
		expect(r.audit).toEqual({ otp: "refused" });
		expect(h.gate.status()).toMatchObject({ openWindows: 0 });
		expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/OTP state could not be saved/));
	});

	it("keeps counting in memory when a failure can't be saved", () => {
		const h = harness({ statePath: join(ROOT, "no-such-dir", "state.json"), maxFailures: 2 });
		expect(() => h.gate.authorize("merge_pull_request", "000000")).toThrow(REFUSED);
		expect(() => h.gate.authorize("merge_pull_request", "000000")).toThrow(REFUSED);
		expect(refusal(() => h.gate.authorize("merge_pull_request", h.code())).audit.otp).toBe("locked");
	});
});

describe("OtpGate lockouts", () => {
	const fail = (h: ReturnType<typeof harness>, times: number) => {
		for (let i = 0; i < times; i++) expect(() => h.gate.authorize("merge_pull_request", "000000")).toThrow(OtpRefusal);
	};

	it("maxFailures bad codes start the short lockout, which refuses even a valid code without counting", () => {
		const h = harness();
		fail(h, 5);
		const state = h.readState();
		expect(state).toMatchObject({ failures: 0, lockedUntil: new Date(T0 + 10 * MIN).toISOString(), lockouts: [new Date(T0).toISOString()], hardLock: null });
		expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/OTP locked until .* after 5 bad codes/));

		const r = refusal(() => h.gate.authorize("merge_pull_request", h.code()));
		expect(r.message).toBe("OTP is locked for 10 more minute(s) after too many bad codes. Nothing was run.");
		expect(r.audit).toEqual({ otp: "locked" });
		h.clock.t = T0 + 10 * MIN - 1000;
		expect(refusal(() => h.gate.authorize("merge_pull_request", h.code())).message).toMatch(/locked for 1 more minute\(s\)/);
		expect(h.readState().failures).toBe(0);
		expect(h.gate.status()).toMatchObject({ lockedUntil: new Date(T0 + 10 * MIN).toISOString(), lockoutsLast24h: 1 });

		h.clock.t = T0 + 10 * MIN;
		expect(h.gate.status()).toMatchObject({ lockedUntil: null });
		expect(h.gate.authorize("merge_pull_request", h.code()).otp).toBe("opened");
		expect(h.readState().lockedUntil).toBeNull(); // an expired lockout is cleared on the next write
	});

	it("maxLockouts short lockouts in 24 h set the hard lock", () => {
		const h = harness({ maxFailures: 1, lockoutSeconds: 60, maxLockouts: 3 });
		for (let i = 0; i < 3; i++) {
			h.clock.t = T0 + i * 2 * MIN;
			fail(h, 1);
		}
		const since = new Date(T0 + 4 * MIN).toISOString();
		expect(h.readState().hardLock).toEqual({ since, lockouts: 3 });
		expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/OTP hard lock after 3 lockouts in 24 h/));

		const r = h.gate.hardLockRefusal()!;
		expect(r.message).toBe(`gh-broker is locked after repeated bad OTP codes (since ${since}). Ask the user to run "${UNLOCK_COMMAND}" on box. Nothing was run.`);
		expect(r.audit).toEqual({ otp: "hard-locked" });
		h.clock.t = T0 + 60 * MIN;
		expect(refusal(() => h.gate.authorize("merge_pull_request", h.code())).audit.otp).toBe("hard-locked");
		expect(h.gate.status()).toMatchObject({ hardLock: { since, lockouts: 3 }, lockoutsLast24h: 3 });

		// The hard lock survives a restart.
		expect(h.make().hardLockRefusal()?.audit.otp).toBe("hard-locked");
	});

	it("only counts lockouts from the last 24 h", () => {
		const h = harness({ maxFailures: 1, lockoutSeconds: 60, maxLockouts: 2 });
		fail(h, 1);
		h.clock.t = T0 + 25 * 60 * MIN;
		fail(h, 1);
		expect(h.readState()).toMatchObject({ hardLock: null, lockouts: [new Date(h.clock.t).toISOString()] });
		expect(h.gate.status()).toMatchObject({ lockoutsLast24h: 1 });
	});

	it("picks up the root CLI's edits without a restart (unlock clears the hard lock)", () => {
		const h = harness({ maxFailures: 1, maxLockouts: 1 });
		fail(h, 1);
		expect(h.gate.hardLockRefusal()).toBeDefined();
		const kept = h.readState().lastAcceptedStep;
		writeFileSync(h.statePath, JSON.stringify({ ...emptyState(), lastAcceptedStep: kept }, null, 2));
		expect(h.gate.hardLockRefusal()).toBeUndefined();
		expect(h.gate.authorize("merge_pull_request", h.code()).otp).toBe("opened");
	});

	it("an edited failure counter is honoured on the next call", () => {
		const h = harness();
		writeFileSync(h.statePath, JSON.stringify({ ...emptyState(), failures: 4 }));
		expect(() => h.gate.authorize("merge_pull_request", "000000")).toThrow(REFUSED);
		expect(h.readState().lockedUntil).not.toBeNull();
	});
});

describe("OtpGate fail-closed state", () => {
	it("a corrupt state file hard-locks everything, and authorize refuses too", () => {
		const h = harness();
		writeFileSync(h.statePath, "{ tampered");
		const r = h.gate.hardLockRefusal()!;
		expect(r.message).toMatch(/^gh-broker is locked after repeated bad OTP codes \(since 2026-11-01T12:00:00\.000Z\)\. Ask the user to run "sudo gh-broker otp unlock" on box\. Nothing was run\.$/);
		expect(refusal(() => h.gate.authorize("merge_pull_request", h.code())).audit.otp).toBe("hard-locked");
		expect(h.gate.status()).toMatchObject({ hardLock: { since: "2026-11-01T12:00:00.000Z", lockouts: 0 }, failures: 0, lockoutsLast24h: 0 });
		// The daemon never overwrites the corrupt file.
		expect(readFileSync(h.statePath, "utf8")).toBe("{ tampered");
	});
});

describe("OtpGate status", () => {
	it("reports the documented fields and never a code or the seed", () => {
		const h = harness();
		const c = h.code();
		h.gate.authorize("merge_pull_request", c);
		const s = h.gate.status();
		expect(s).toEqual({
			configured: true,
			gatedTools: ["merge_pull_request"],
			windowSeconds: 300,
			openWindows: 1,
			nextWindowExpiresAt: new Date(T0 + 5 * MIN).toISOString(),
			failures: 0,
			maxFailures: 5,
			lockedUntil: null,
			lockoutsLast24h: 0,
			maxLockouts: 3,
			hardLock: null,
			unlockCommand: "sudo gh-broker otp unlock",
			host: "box"
		});
		const text = JSON.stringify(s);
		expect(text).not.toContain(c);
		expect(text).not.toContain(SEED);
	});

	it("reports configured:false when the seed isn't stored", () => {
		const h = harness({}, "");
		expect(h.gate.status()).toMatchObject({ configured: false, gatedTools: ["merge_pull_request"] });
	});

	it("is inert without config.otp: no lock, defaults only, no state file read", () => {
		const h = harness(null);
		const gate = new OtpGate(h.config, h.secrets as any);
		expect(gate.enabled).toBe(false);
		expect(gate.hardLockRefusal()).toBeUndefined();
		expect(gate.status()).toEqual({
			configured: false,
			gatedTools: ["merge_pull_request"],
			windowSeconds: 300,
			openWindows: 0,
			nextWindowExpiresAt: null,
			failures: 0,
			maxFailures: 5,
			lockedUntil: null,
			lockoutsLast24h: 0,
			maxLockouts: 3,
			hardLock: null,
			unlockCommand: UNLOCK_COMMAND,
			host: hostname()
		});
	});
});
