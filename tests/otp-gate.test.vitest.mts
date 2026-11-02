import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { OtpGate, OtpRefusal, UNLOCK_COMMAND, unlockCommand, windowText } from "../src/otp/gate.ts";
import { DEFAULT_GATED, OTP_DEFAULTS, isGated, otpSettings, otpSetupProblem, readSeed } from "../src/otp/policy.ts";
import { base32Encode, hotp, stepAt, totpAt } from "../src/otp/totp.ts";
import { emptyState, emptyUser } from "../src/otp/state.ts";

const KEY = Buffer.from("12345678901234567890", "ascii");
const SEED = base32Encode(KEY);
const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const MIN = 60_000;
const TOOL = "merge_pull_request";

const ROOT = join(process.cwd(), "tmp", "otp-gate-tests");
let n = 0;

function makeConfig(otp: Record<string, unknown> | null, dir: string): any {
	return {
		listen: "agents:/run/gh-broker/agents",
		upstream: "https://api.githubcopilot.com/mcp/",
		owners: { cldmv: { read: "cred:r", write: "cred:w" } },
		tools: [
			{ name: TOOL, mode: "write", otp: true },
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
	/** authorize() as `user` (default "repo"). */
	const auth = (c: unknown, user = "repo", g = gate) => g.authorize(TOOL, c, user);
	return { dir, clock, secrets, config, gate, make, code, statePath, readState, auth };
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

const REFUSED = /^OTP required for merge_pull_request: ask the user for a current code from their authenticator app and pass it as "otp"\. Nothing was run\.$/;

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

/** The audit lines (console.log JSON) written so far. */
const auditLines = (): Array<Record<string, unknown>> => vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)));
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

	it("windowText and unlockCommand", () => {
		expect(windowText(300)).toBe("5 minutes");
		expect(windowText(60)).toBe("1 minute");
		expect(windowText(90)).toBe("90 seconds");
		expect(UNLOCK_COMMAND).toBe("sudo gh-broker otp unlock");
		expect(unlockCommand("repo")).toBe("sudo gh-broker otp unlock repo");
	});
});

describe("OtpGate windows", () => {
	it("opens a window on a valid code and accepts the same code for the whole window, then refuses it", () => {
		const h = harness();
		const c = h.code();
		const opened = h.auth(c);
		expect(opened).toEqual({ otp: "opened", window: expect.stringMatching(/^[0-9a-f]{16}$/), until: new Date(T0 + 5 * MIN).toISOString() });
		expect(opened.window).not.toContain(c);
		expect(h.readState()).toEqual({ version: 1, lastAcceptedStep: stepAt(T0), users: {} });

		h.clock.t = T0 + 5 * MIN - 1;
		expect(h.auth(c)).toEqual({ otp: "window", window: opened.window });

		h.clock.t = T0 + 5 * MIN;
		const r = refusal(() => h.auth(c));
		expect(r.message).toMatch(REFUSED);
		expect(r.audit).toEqual({ otp: "refused" });
		expect(h.readState().users).toEqual({ repo: { failures: 1, lockedUntil: null, lockouts: [], hardLock: null } });
	});

	it("a window belongs to the user who opened it, even for the same code", () => {
		const h = harness();
		const c = h.code();
		h.auth(c, "repo");
		// glmtest sends the same code: it isn't repo's window, and the code is spent for everyone.
		// It is a real code, though, so it isn't counted as a guess.
		expect(refusal(() => h.auth(c, "glmtest")).message).toMatch(REFUSED);
		expect(h.readState().users).toEqual({});
		expect(h.auth(c, "repo").otp).toBe("window");
		expect(h.gate.status("glmtest")).toMatchObject({ openWindows: 0, failures: 0 });
		expect(h.gate.status("repo")).toMatchObject({ openWindows: 1, failures: 0 });
	});

	it("each user can open their own window with their own code", () => {
		const h = harness();
		const a = h.auth(h.code(), "repo");
		h.clock.t = T0 + 30_000;
		const b = h.auth(h.code(), "glmtest");
		expect(b.otp).toBe("opened");
		expect(b.window).not.toBe(a.window);
	});

	it("a reused code can't open a second window, even when it is still a valid TOTP", () => {
		const h = harness({ windowSeconds: 10 });
		const c = h.code();
		h.auth(c);
		h.clock.t = T0 + 15_000; // window closed, the code's step is still within ±1
		expect(refusal(() => h.auth(c)).audit.otp).toBe("refused");
		expect(h.gate.status("repo")).toMatchObject({ failures: 0 }); // spent, not a guess
	});

	it("a restart closes the windows and the persisted step stops the old code reopening one", () => {
		const h = harness();
		const c = h.code();
		h.auth(c);
		const restarted = h.make();
		expect(refusal(() => h.auth(c, "repo", restarted)).message).toMatch(REFUSED);
		expect(restarted.status("repo")).toMatchObject({ openWindows: 0, failures: 0 });
	});

	it("an older code than the last accepted one is refused", () => {
		const h = harness();
		h.auth(h.code());
		expect(() => h.auth(hotp(KEY, stepAt(T0) - 1))).toThrow(REFUSED);
	});

	it("keeps several windows open at once for one user, one per code", () => {
		const h = harness();
		const a = h.auth(h.code());
		h.clock.t = T0 + 30_000;
		const b = h.auth(h.code());
		expect(b.otp).toBe("opened");
		expect(b.window).not.toBe(a.window);
		expect(h.gate.status("repo")).toMatchObject({ openWindows: 2, nextWindowExpiresAt: new Date(T0 + 5 * MIN).toISOString() });
		expect(h.auth(totpAt(KEY, T0))).toEqual({ otp: "window", window: a.window });
	});

	it("a missing code is refused without counting as a failure", () => {
		const h = harness();
		for (const missing of [undefined, null, ""]) expect(refusal(() => h.auth(missing)).message).toMatch(REFUSED);
		expect(h.gate.status("repo")).toMatchObject({ failures: 0 });
	});

	it("wrong, malformed and non-string codes are refused and counted", () => {
		const h = harness();
		const wrong = String((Number(h.code()) + 1) % 1_000_000).padStart(6, "0");
		for (const bad of [wrong, "12345", "abcdef", 123456]) expect(refusal(() => h.auth(bad)).message).toMatch(REFUSED);
		expect(h.readState().users.repo.failures).toBe(4);
	});

	it("a valid code resets the user's failure counter and drops their now-empty entry", () => {
		const h = harness();
		expect(() => h.auth("000000")).toThrow(REFUSED);
		h.auth(h.code());
		expect(h.readState().users).toEqual({});
	});

	it("refuses to open a window when the state can't be saved", () => {
		const h = harness({ statePath: join(ROOT, "no-such-dir", "state.json") });
		const r = refusal(() => h.auth(h.code()));
		expect(r.message).toBe("OTP could not be checked: the broker could not save its OTP state. Nothing was run.");
		expect(r.audit).toEqual({ otp: "refused" });
		expect(h.gate.status("repo")).toMatchObject({ openWindows: 0 });
		expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/OTP state could not be saved/));
	});

	it("after a failure that can't be saved, refuses that user until the counters are on disk", () => {
		const missing = join(ROOT, "late-dir");
		const h = harness({ statePath: join(missing, "state.json"), maxFailures: 2 });
		expect(() => h.auth("000000")).toThrow(REFUSED);
		const r = refusal(() => h.auth(h.code()));
		expect(r.message).toBe("OTP could not be checked: the broker could not save its OTP state. Nothing was run.");
		mkdirSync(missing);
		expect(() => h.auth("000000")).toThrow(REFUSED); // the saved count is 1, so this is the 2nd bad code
		expect(JSON.parse(readFileSync(join(missing, "state.json"), "utf8")).users.repo).toMatchObject({ failures: 0, lockouts: [expect.any(String)] });
		expect(refusal(() => h.auth(h.code())).audit.otp).toBe("locked");
	});
});

describe("OtpGate code types", () => {
	it("reads a JSON number as six digits, restoring a dropped leading zero", () => {
		const h = harness();
		let t = T0;
		// Find a moment whose code starts with 0, so the number form loses a digit.
		while (h.code(t)[0] !== "0") t += 30_000;
		h.clock.t = t;
		const n = Number(h.code(t));
		expect(String(n).length).toBeLessThan(6);
		expect(h.auth(n as unknown as string).otp).toBe("opened");
		expect(h.auth(h.code(t)).otp).toBe("window");
	});

	it("refuses other non-strings, and out-of-range numbers, without counting a bad code", () => {
		const h = harness();
		for (const bad of [true, { code: "123456" }, ["123456"], 1.5, -1, 1_000_000]) expect(refusal(() => h.auth(bad as unknown as string)).message).toMatch(REFUSED);
		expect(h.gate.status("repo")).toMatchObject({ failures: 0 });
	});
});

describe("OtpGate lockouts", () => {
	const fail = (h: ReturnType<typeof harness>, times: number, user = "repo") => {
		for (let i = 0; i < times; i++) expect(() => h.auth("000000", user)).toThrow(OtpRefusal);
	};

	it("maxFailures bad codes start that user's short lockout, which refuses even a valid code without counting", () => {
		const h = harness();
		fail(h, 5);
		expect(h.readState().users.repo).toEqual({ failures: 0, lockedUntil: new Date(T0 + 10 * MIN).toISOString(), lockouts: [new Date(T0).toISOString()], hardLock: null });
		expect(auditLines()).toEqual([expect.objectContaining({ tool: "merge_pull_request", user: "repo", decision: "deny", otp: "lockout", until: new Date(T0 + 10 * MIN).toISOString(), detail: "5 bad codes" })]);

		const r = refusal(() => h.auth(h.code()));
		expect(r.message).toBe("OTP is locked for 10 more minute(s) after too many bad codes. Nothing was run.");
		expect(r.audit).toEqual({ otp: "locked" });
		// Another user is not affected.
		expect(h.auth(h.code(), "glmtest").otp).toBe("opened");

		h.clock.t = T0 + 10 * MIN - 1000;
		expect(refusal(() => h.auth(h.code())).message).toMatch(/locked for 1 more minute\(s\)/);
		expect(h.readState().users.repo.failures).toBe(0);
		expect(h.gate.status("repo")).toMatchObject({ lockedUntil: new Date(T0 + 10 * MIN).toISOString(), lockoutsLast24h: 1 });

		h.clock.t = T0 + 10 * MIN;
		expect(h.gate.status("repo")).toMatchObject({ lockedUntil: null });
		expect(h.auth(h.code()).otp).toBe("opened");
		expect(h.readState().users.repo.lockedUntil).toBeNull(); // an expired lockout is cleared on the next write
	});

	it("maxLockouts short lockouts in 24 h hard-lock that user only", () => {
		const h = harness({ maxFailures: 1, lockoutSeconds: 60, maxLockouts: 3 });
		for (let i = 0; i < 3; i++) {
			h.clock.t = T0 + i * 2 * MIN;
			fail(h, 1);
		}
		const since = new Date(T0 + 4 * MIN).toISOString();
		expect(h.readState().users.repo.hardLock).toEqual({ since, lockouts: 3 });
		expect(auditLines().at(-1)).toMatchObject({ user: "repo", decision: "deny", otp: "hard-lock", detail: '3 lockouts in 24 h; every tool except otp_status is refused until "sudo gh-broker otp unlock repo"' });

		const r = h.gate.hardLockRefusal("repo")!;
		expect(r.message).toBe(`gh-broker is locked for repo after repeated bad OTP codes (since ${since}). Ask the user to run "sudo gh-broker otp unlock repo" on box. Nothing was run.`);
		expect(r.audit).toEqual({ otp: "hard-locked" });
		expect(h.gate.hardLockRefusal("glmtest")).toBeUndefined();
		h.clock.t = T0 + 60 * MIN;
		expect(refusal(() => h.auth(h.code())).audit.otp).toBe("hard-locked");
		expect(h.auth(h.code(), "glmtest").otp).toBe("opened");
		expect(h.gate.status("repo")).toMatchObject({ hardLock: { since, lockouts: 3 }, lockoutsLast24h: 3 });
		const lockedUsers = [{ user: "repo", since, lockouts: 3, unlockCommand: "sudo gh-broker otp unlock repo" }];
		expect(h.gate.status("glmtest")).toMatchObject({ user: "glmtest", hardLock: null, lockedUsers });

		// The hard lock survives a restart.
		expect(h.make().hardLockRefusal("repo")?.audit.otp).toBe("hard-locked");
	});

	it("only counts lockouts from the last 24 h", () => {
		const h = harness({ maxFailures: 1, lockoutSeconds: 60, maxLockouts: 2 });
		fail(h, 1);
		h.clock.t = T0 + 25 * 60 * MIN;
		fail(h, 1);
		expect(h.readState().users.repo).toMatchObject({ hardLock: null, lockouts: [new Date(h.clock.t).toISOString()] });
		expect(h.gate.status("repo")).toMatchObject({ lockoutsLast24h: 1 });
	});

	it("prunes other users' expired entries on write", () => {
		const h = harness();
		const old = new Date(T0 - 25 * 60 * MIN).toISOString();
		writeFileSync(h.statePath, JSON.stringify({ ...emptyState(), users: { stale: { ...emptyUser(), lockedUntil: old, lockouts: [old] }, kept: { ...emptyUser(), failures: 2 } } }));
		fail(h, 1);
		expect(h.readState().users).toEqual({ kept: { ...emptyUser(), failures: 2 }, repo: { ...emptyUser(), failures: 1 } });
	});

	it("picks up the root CLI's edits without a restart (unlock clears the hard lock)", () => {
		const h = harness({ maxFailures: 1, maxLockouts: 1 });
		fail(h, 1);
		expect(h.gate.hardLockRefusal("repo")).toBeDefined();
		const kept = h.readState().lastAcceptedStep;
		writeFileSync(h.statePath, JSON.stringify({ ...emptyState(), lastAcceptedStep: kept }, null, 2));
		expect(h.gate.hardLockRefusal("repo")).toBeUndefined();
		expect(h.auth(h.code()).otp).toBe("opened");
	});

	it("an edited failure counter is honoured on the next call", () => {
		const h = harness();
		writeFileSync(h.statePath, JSON.stringify({ ...emptyState(), users: { repo: { ...emptyUser(), failures: 4 } } }));
		expect(() => h.auth("000000")).toThrow(REFUSED);
		expect(h.readState().users.repo.lockedUntil).not.toBeNull();
	});
});

describe("OtpGate fail-closed state", () => {
	it("a corrupt state file hard-locks every user, and authorize refuses too", () => {
		const h = harness();
		writeFileSync(h.statePath, "{ tampered");
		for (const user of ["repo", "glmtest"]) {
			expect(h.gate.hardLockRefusal(user)!.message).toBe(
				`gh-broker is locked for ${user} after repeated bad OTP codes (since 2026-11-01T12:00:00.000Z). Ask the user to run "sudo gh-broker otp unlock ${user}" on box. Nothing was run.`
			);
		}
		expect(refusal(() => h.auth(h.code())).audit.otp).toBe("hard-locked");
		expect(h.gate.status("repo")).toMatchObject({
			hardLock: { since: "2026-11-01T12:00:00.000Z", lockouts: 0 },
			lockedUsers: [{ user: "repo", since: "2026-11-01T12:00:00.000Z", lockouts: 0, unlockCommand: "sudo gh-broker otp unlock repo" }],
			failures: 0,
			lockoutsLast24h: 0
		});
		// The daemon never overwrites the corrupt file.
		expect(readFileSync(h.statePath, "utf8")).toBe("{ tampered");
	});

	it("round 1's flat shape is corrupt now (no users object)", () => {
		const h = harness();
		writeFileSync(h.statePath, JSON.stringify({ version: 1, lastAcceptedStep: 0, failures: 0, lockedUntil: null, lockouts: [], hardLock: null }));
		expect(h.gate.hardLockRefusal("repo")).toBeDefined();
	});
});

describe("OtpGate status", () => {
	it("reports the documented fields for the caller and never a code or the seed", () => {
		const h = harness();
		const c = h.code();
		h.auth(c);
		const s = h.gate.status("repo");
		expect(s).toEqual({
			configured: true,
			user: "repo",
			gatedTools: [TOOL],
			windowSeconds: 300,
			openWindows: 1,
			nextWindowExpiresAt: new Date(T0 + 5 * MIN).toISOString(),
			failures: 0,
			maxFailures: 5,
			lockedUntil: null,
			lockoutsLast24h: 0,
			maxLockouts: 3,
			hardLock: null,
			unlockCommand: "sudo gh-broker otp unlock repo",
			lockedUsers: [],
			host: "box"
		});
		const text = JSON.stringify(s);
		expect(text).not.toContain(c);
		expect(text).not.toContain(SEED);
	});

	it("reports configured:false when the seed isn't stored", () => {
		const h = harness({}, "");
		expect(h.gate.status("repo")).toMatchObject({ configured: false, gatedTools: [TOOL] });
	});

	it("is inert without config.otp: no lock, defaults only, no state file read", () => {
		const h = harness(null);
		const gate = new OtpGate(h.config, h.secrets as any);
		expect(gate.enabled).toBe(false);
		expect(gate.hardLockRefusal("repo")).toBeUndefined();
		expect(gate.status("repo")).toEqual({
			configured: false,
			user: "repo",
			gatedTools: [TOOL],
			windowSeconds: 300,
			openWindows: 0,
			nextWindowExpiresAt: null,
			failures: 0,
			maxFailures: 5,
			lockedUntil: null,
			lockoutsLast24h: 0,
			maxLockouts: 3,
			hardLock: null,
			unlockCommand: "sudo gh-broker otp unlock repo",
			lockedUsers: [],
			host: hostname()
		});
	});
});
