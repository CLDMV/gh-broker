import { describe, it, expect } from "vitest";
import * as cli from "../src/cli/otp.ts";
import * as state from "../src/otp/state.ts";
import { windowText as gateWindowText } from "../src/otp/gate.ts";
import { windowText as policyWindowText } from "../src/otp/policy.ts";

// Pins for the OTP state-format unification (design #175 slice 0): the state-format helpers
// the daemon and the CLI shared now have ONE implementation, in src/otp/state.ts, and
// src/cli/otp.ts re-exports them at its old import path. These tests pin that the old paths
// are the very same functions (identity, not copies) and that the unified validators accept
// and reject exactly what the daemon's parseState does.

const user = { failures: 2, lockedUntil: "2026-11-01T12:05:00.000Z", lockouts: ["2026-11-01T12:00:00.000Z"], hardLock: null };
const good = { version: 1, lastAcceptedStep: 7, users: { repo: user, glmtest: state.emptyUser() } };

describe("the old import paths are the shared implementations", () => {
	it("cli/otp.ts re-exports state.ts's functions, not copies", () => {
		expect(cli.emptyState).toBe(state.emptyState);
		expect(cli.emptyUser).toBe(state.emptyUser);
		expect(cli.validState).toBe(state.validState);
		expect(cli.validUser).toBe(state.validUser);
		expect(cli.userOf).toBe(state.userState);
		expect(cli.withoutUser).toBe(state.withoutUser);
		expect(cli.withoutUsers).toBe(state.withoutUsers);
		expect(cli.spendRecentCodes).toBe(state.spendRecentCodes);
		expect(cli.secondsUntilFreshCode).toBe(state.secondsUntilFreshCode);
		expect(cli.describeUser).toBe(state.describeUser);
		expect(cli.describeUsers).toBe(state.describeUsers);
		expect(cli.formatStatus).toBe(state.formatStatus);
	});

	it("gate.ts re-exports policy.ts's windowText, not a copy", () => {
		expect(gateWindowText).toBe(policyWindowText);
	});

	it("the default limit constants moved with describeUser", () => {
		expect(cli.DEFAULT_MAX_FAILURES).toBe(state.DEFAULT_MAX_FAILURES);
		expect(cli.DEFAULT_MAX_LOCKOUTS).toBe(state.DEFAULT_MAX_LOCKOUTS);
	});
});

describe("validState is parseState", () => {
	const bad: unknown[] = [
		null,
		[],
		"state",
		{ version: 2, lastAcceptedStep: 0, users: {} },
		{ ...good, lastAcceptedStep: -1 },
		{ ...good, lastAcceptedStep: "7" },
		{ ...good, lastAcceptedStep: 1.5 },
		{ ...good, users: [] },
		{ ...good, users: { repo: null } },
		{ ...good, users: { repo: { ...user, failures: -2 } } },
		{ ...good, users: { repo: { ...user, failures: 1.5 } } },
		{ ...good, users: { repo: { ...user, lockedUntil: "nope" } } },
		{ ...good, users: { repo: { ...user, lockouts: "x" } } },
		{ ...good, users: { repo: { ...user, lockouts: ["nope"] } } },
		{ ...good, users: { repo: { ...user, hardLock: {} } } },
		{ ...good, users: { repo: { ...user, hardLock: { since: "2026-11-01T12:00:00Z", lockouts: "3" } } } },
		{ ...good, users: { "Not A Name": state.emptyUser() } },
		{ ...good, users: { root: state.emptyUser() } }
	];

	it("accepts and rejects exactly what parseState does", () => {
		expect(cli.validState(good)).toBe(true);
		expect(state.parseState(good)).toEqual(good);
		for (const v of bad) {
			expect(cli.validState(v), `validState(${JSON.stringify(v)})`).toBe(false);
			expect(state.parseState(v), `parseState(${JSON.stringify(v)})`).toBeUndefined();
		}
	});

	it("validUser accepts and rejects the same per-user entries parseState builds", () => {
		expect(cli.validUser(user)).toBe(true);
		expect(cli.validUser({ ...user, hardLock: { since: "2026-11-01T12:00:00Z", lockouts: 3 } })).toBe(true);
		expect(cli.validUser(state.emptyUser())).toBe(true);
		for (const v of [null, [], {}, { ...user, failures: -1 }, { ...user, lockedUntil: 5 }, { ...user, lockouts: [1] }, { ...user, hardLock: { since: 5, lockouts: 1 } }]) {
			expect(cli.validUser(v)).toBe(false);
		}
	});
});

describe("userOf has the copy semantics of userState", () => {
	it("returns a fresh copy: mutating it leaves the state alone", () => {
		const read = cli.userOf(good, "repo");
		read.failures = 99;
		read.lockouts.push("2026-11-01T13:00:00.000Z");
		expect(good.users.repo).toEqual(user);
	});

	it("ignores inherited keys and fills all-zero for unknown users", () => {
		expect(cli.userOf(cli.emptyState(), "constructor")).toEqual(cli.emptyUser());
		expect(cli.userOf(good, "nobody")).toEqual(cli.emptyUser());
	});
});

describe("the CLI status prose kept its exact shape at the shared home", () => {
	it("describeUser takes the same limits and clock", () => {
		const now = Date.parse("2026-11-01T12:02:00.000Z"); // while the short lockout (until 12:05) still runs
		expect(cli.describeUser(user, { maxFailures: 4, maxLockouts: 2 }, now)).toEqual({
			locked: true,
			failures: 2,
			maxFailures: 4,
			lockedUntil: "2026-11-01T12:05:00.000Z",
			lockoutsLast24h: 1,
			maxLockouts: 2,
			hardLock: null
		});
	});

	it("formatStatus takes the same unlockCommand text", () => {
		const lines = cli.formatStatus([{ user: "repo", locked: true, failures: 0, maxFailures: 5, lockedUntil: null, lockoutsLast24h: 3, maxLockouts: 3, hardLock: { since: "2026-11-01T12:00:00.000Z", lockouts: 3 } }], {
			statePath: "/var/lib/gh-broker/otp-state.json",
			fileStatus: "ok",
			configured: true,
			unlockCommand: "sudo gh-broker otp unlock"
		});
		expect(lines).toContain("  HARD LOCK since 2026-11-01T12:00:00.000Z after 3 lockouts. Clear it with: sudo gh-broker otp unlock repo");
	});
});
