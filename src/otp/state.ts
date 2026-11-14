/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/otp/state.ts
 *	@Date: 2026-11-01T20:43:25-08:00 (1793594605)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T07:38:52-08:00 (1794670732)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The OTP gate's persistent state: the last accepted TOTP step (global: there is one seed,
 * so a code is spent for everyone once used) and, per agent user, the bad-code counter and
 * the lockouts. The daemon writes it; the root CLI (`gh-broker otp unlock <user>`) edits it.
 *
 * - Written atomically: a temp file in the same directory (mode 0600), fsync, rename.
 * - Re-read whenever the file's inode, mtime or size changed since the last read (one
 *   stat per call), so the CLI's edits apply on the next call without a restart.
 * - A missing file is the all-zero state, and a user with no entry is all zero/null. A file
 *   that can't be read or parsed, or that doesn't have the expected shape, fails closed: it
 *   reads as corrupt, which the gate treats as a hard lock for every user, so tampering with
 *   the file can never unlock anything.
 *
 * The state-format helpers both sides share live here too — the validators, the copy
 * accessor, the CLI's spend/clear transforms and the `otp status` prose — so the file
 * contract has exactly one implementation (the CLI re-exports them at its old path).
 */

import { closeSync, fstatSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { DEFAULTS, describeUser as libDescribeUser, formatStatus as libFormatStatus, spendThrough } from "@cldmv/lib-otp";
import { isAgentUser } from "../agents.ts";
import { STEP_SECONDS } from "./totp.ts";

export interface HardLock {
	since: string;
	lockouts: number;
}

/** One agent user's counters. */
export interface UserState {
	/** Bad codes since the user's last accepted code or last short lockout. */
	failures: number;
	/** ISO end of the current short lockout, or null. */
	lockedUntil: string | null;
	/** ISO start times of short lockouts, pruned to the last 24 h on every write. */
	lockouts: string[];
	hardLock: HardLock | null;
}

export interface OtpState {
	version: 1;
	/** Highest TOTP step that opened a window; a code at or below it can't open another. */
	lastAcceptedStep: number;
	users: Record<string, UserState>;
}

/**
 * One person's record in `@cldmv/lib-otp`'s machine (its `PersonState`, declared structurally
 * here — the package's index doesn't re-export the type). The persisted fields (`failures`
 * through `hardLock`) are the file's {@link UserState}; the rest is memory-tier.
 */
export interface MachinePerson {
	/** Bad codes since the last accepted code or short lockout. */
	failures: number;
	/** Ms timestamps of those failures — maintained only in window-counting mode, which the daemon doesn't use. */
	failureTimes: number[];
	/** ISO end of the current short lockout, or null. */
	lockedUntil: string | null;
	/** ISO start times of short lockouts, pruned to the hard-lock window. */
	lockouts: string[];
	/** The hard lock snapshot, if any. */
	hardLock: HardLock | null;
	/** Highest accepted TOTP counter — the gate threads the global step into it. */
	lastCounter: number;
	/** The period `lastCounter` was computed under, or 0 when nothing was accepted. */
	lastAcceptedPeriod: number;
	/** Open reuse windows (memory-tier: ids and expiry only, never a code). */
	windows: { id: string; expiresAt: number }[];
}

/** What a read returns: the state, or a marker that the file is unusable. */
export type StateRead = { ok: true; state: OtpState } | { ok: false; since: string };

/**
 * The gate's persistence seam (design #175 §2d): the gate reads lock state through this and
 * writes it back, so the machine (src/otp/gate.ts's host code) never touches the file itself.
 * {@link OtpStateFile} is the implementation. `write` throws when persistence failed; after a
 * throw, `read` serves the attempted state — with the in-memory counters it carried — until the
 * file's signature changes, which is what keeps a failed write from resetting a count or
 * handing back a spent code. That contract is pinned in tests/otp-machine-pin.test.vitest.mts.
 */
export interface LockStateStore {
	read(): StateRead;
	write(state: OtpState): void;
}

/** What the CLI's {@link readState} (src/cli/otp.ts) returns: how the file stood, and the state to use. */
export interface StateReading {
	status: "ok" | "missing" | "corrupt";
	state: OtpState;
}

export function emptyState(): OtpState {
	return { version: 1, lastAcceptedStep: 0, users: {} };
}

export function emptyUser(): UserState {
	return { failures: 0, lockedUntil: null, lockouts: [], hardLock: null };
}

/** `user`'s counters (a fresh copy), all zero/null when the user has no entry. */
export function userState(state: OtpState, user: string): UserState {
	const u = Object.hasOwn(state.users, user) ? state.users[user]! : emptyUser();
	// Every field is a fresh copy — hardLock included, so a caller mutating the returned
	// snapshot can never reach the shared state.
	return { ...u, lockouts: [...u.lockouts], hardLock: u.hardLock === null ? null : { ...u.hardLock } };
}

/** `user`'s entry, or all-zero when it has none — an alias of {@link userState}: always a fresh copy. */
export const userOf = userState;

/**
 * `user`'s record as the @cldmv/lib-otp machine sees it: the file's persisted fields padded
 * with the memory-tier ones the file format doesn't carry (`failureTimes`, the per-person
 * counter — the daemon threads the global step into it — and `windows`, which the gate merges
 * back from its per-process map and never persists).
 */
export function personOf(user: UserState): MachinePerson {
	return {
		failures: user.failures,
		failureTimes: [],
		lockedUntil: user.lockedUntil,
		lockouts: [...user.lockouts],
		hardLock: user.hardLock === null ? null : { ...user.hardLock },
		lastCounter: 0,
		lastAcceptedPeriod: 0,
		windows: []
	};
}

const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseUser(raw: unknown): UserState | undefined {
	if (!isObject(raw) || !isCount(raw.failures)) return undefined;
	if (raw.lockedUntil !== null && !isIso(raw.lockedUntil)) return undefined;
	if (!Array.isArray(raw.lockouts) || !raw.lockouts.every(isIso)) return undefined;
	let hardLock: HardLock | null = null;
	if (raw.hardLock !== null) {
		const h = raw.hardLock;
		if (!isObject(h) || !isIso(h.since) || !isCount(h.lockouts)) return undefined;
		hardLock = { since: h.since, lockouts: h.lockouts };
	}
	return { failures: raw.failures, lockedUntil: raw.lockedUntil, lockouts: [...raw.lockouts], hardLock };
}

/**
 * Validate a parsed state file. Unknown extra keys are ignored; a malformed user entry, or a key
 * that isn't a valid agent user name (see isAgentUser), rejects the file.
 */
export function parseState(raw: unknown): OtpState | undefined {
	if (!isObject(raw) || raw.version !== 1 || !isCount(raw.lastAcceptedStep) || !isObject(raw.users)) return undefined;
	const users: Record<string, UserState> = {};
	for (const [name, entry] of Object.entries(raw.users)) {
		const u = parseUser(entry);
		if (!u || !isAgentUser(name)) return undefined;
		users[name] = u;
	}
	return { version: 1, lastAcceptedStep: raw.lastAcceptedStep, users };
}

/** Whether `v` is a well-formed per-user entry: the same acceptance as {@link parseState}. */
export function validUser(v: unknown): v is UserState {
	return parseUser(v) !== undefined;
}

/** Whether `v` is a well-formed version 1 state object: the same acceptance as {@link parseState}. */
export function validState(v: unknown): v is OtpState {
	return parseState(v) !== undefined;
}

/** The state with one user's entry cleared (no entry means all-zero). `lastAcceptedStep` is kept so a spent code can't be replayed. */
export function withoutUser(state: OtpState, user: string): OtpState {
	const { [user]: _gone, ...users } = state.users;
	return { ...state, users };
}

/** The state with every user cleared. */
export function withoutUsers(state: OtpState): OtpState {
	return { ...state, users: {} };
}

/**
 * `state` ready to be written by the CLI: every code up to one step ahead of `now` counts as
 * spent. The spend is the package's spendThrough at the machine defaults (period 30 s, skew 1
 * step — the daemon's fixed numbers), which is exactly the old `floor(now / 30 s) + 1`. The CLI
 * rewrites the whole file while the daemon may be accepting a code (it accepts at most one step
 * ahead), so this keeps a write from handing back a code the daemon just used. The cost is that
 * the code an authenticator shows now, and the one after it, can't open a window; see
 * secondsUntilFreshCode.
 */
export function spendRecentCodes(state: OtpState, now: number): OtpState {
	return { ...state, lastAcceptedStep: Math.max(state.lastAcceptedStep, spendThrough(now, DEFAULTS)) };
}

/** Seconds from `now` until an authenticator shows a code spendRecentCodes(…, now) didn't spend (31 to 60). */
export function secondsUntilFreshCode(now: number): number {
	return Math.ceil(((spendThrough(now, DEFAULTS) + 1) * STEP_SECONDS * 1000 - now) / 1000);
}

/** The lockout limits the CLI reports against when config.otp doesn't set them (OTP_DEFAULTS in src/otp/policy.ts). */
export const DEFAULT_MAX_FAILURES = 5;
export const DEFAULT_MAX_LOCKOUTS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The lockout limits the CLI reports against. */
export interface OtpLimits {
	maxFailures?: number;
	maxLockouts?: number;
}

/** One user's lock facts, as {@link describeUser} computes them. */
export interface UserFacts {
	locked: boolean;
	failures: number | null;
	maxFailures: number;
	lockedUntil: string | null;
	lockoutsLast24h: number | null;
	maxLockouts: number;
	hardLock: UserState["hardLock"];
}

/** A {@link UserFacts} with the user it is about; `corrupt` marks a user locked by an unreadable state file. */
export interface UserStatus extends UserFacts {
	user: string;
	corrupt?: true;
}

/**
 * One user's facts for `status`, from their entry and the config's limits. The facts are the
 * package's describeUser over the user's machine record (padded by personOf); this wrapper
 * renames its `lockoutsInWindow` to the CLI's `lockoutsLast24h` and fills the daemon's limits.
 */
export function describeUser(user: UserState, { maxFailures = DEFAULT_MAX_FAILURES, maxLockouts = DEFAULT_MAX_LOCKOUTS }: OtpLimits = {}, now = Date.now()): UserFacts {
	const f = libDescribeUser(personOf(user), { maxFailures, maxLockouts, windowMs: DAY_MS }, now);
	return {
		locked: f.locked,
		failures: f.failures,
		maxFailures: f.maxFailures,
		lockedUntil: f.lockedUntil,
		lockoutsLast24h: f.lockoutsInWindow,
		maxLockouts: f.maxLockouts,
		hardLock: f.hardLock
	};
}

/**
 * The per-user facts for the given users (registered agents plus any user the file mentions).
 * A corrupt file locks every one of them, as the daemon does.
 */
export function describeUsers({ status, state }: StateReading, users: string[], limits: OtpLimits = {}, now = Date.now()): UserStatus[] {
	const names = [...new Set([...users, ...Object.keys(state.users)])].sort();
	return names.map((user): UserStatus =>
		status === "corrupt"
			? { user, corrupt: true, locked: true, failures: null, maxFailures: limits.maxFailures ?? DEFAULT_MAX_FAILURES, lockedUntil: null, lockoutsLast24h: null, maxLockouts: limits.maxLockouts ?? DEFAULT_MAX_LOCKOUTS, hardLock: null }
			: { user, ...describeUser(userOf(state, user), limits, now) }
	);
}

/** `d`'s facts in the package formatter's shape (it names the field `lockoutsInWindow`). */
function asPersonStatus(d: UserStatus): { person: string; locked: boolean; failures: number; maxFailures: number; lockedUntil: string | null; lockoutsInWindow: number; maxLockouts: number; hardLock: UserState["hardLock"] } {
	return { person: d.user, locked: d.locked, failures: d.failures!, maxFailures: d.maxFailures, lockedUntil: d.lockedUntil, lockoutsInWindow: d.lockoutsLast24h!, maxLockouts: d.maxLockouts, hardLock: d.hardLock };
}

/**
 * Human-readable lines for `describeUsers`'s result. The header, the state-file line, the
 * corrupt-file notice and the empty-list line are the CLI's own prose (the package's formatter
 * has no state-file or corrupt concept); each user's block comes from the package's
 * formatStatus over that one user, byte-identical to the prose it replaces — the package's own
 * header line (`OTP configured: yes`) is dropped, since the daemon's header carries the
 * not-configured hint.
 */
export function formatStatus(
	users: UserStatus[],
	{
		statePath,
		fileStatus,
		configured,
		unlockCommand = "sudo gh-broker otp unlock"
	}: { statePath: string; fileStatus: StateReading["status"]; configured: boolean; unlockCommand?: string }
): string[] {
	const lines = [`OTP configured: ${configured ? "yes" : "no (re-run the installer to set it up)"}`, `state file: ${statePath} (${fileStatus})`];
	if (fileStatus === "corrupt") lines.push("LOCKED: the state file is unreadable, so the broker treats every user as hard-locked.", `Clear it with: ${unlockCommand} --all`);
	if (users.length === 0) lines.push("no agents registered");
	for (const d of users) {
		if (d.corrupt) {
			lines.push(`${d.user}:`, "  locked (state file unreadable)");
			continue;
		}
		lines.push(...libFormatStatus([asPersonStatus(d)], { configured: true, unlockCommand }).slice(1));
	}
	return lines;
}

/** Identity of one version of the file on disk; any change means re-read. */
function signature(path: string): string {
	try {
		const st = statSync(path);
		return `${st.ino}:${st.mtimeMs}:${st.size}`;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		return `error:${(err as NodeJS.ErrnoException).code}`;
	}
}

export class OtpStateFile implements LockStateStore {
	readonly path: string;
	private readonly now: () => number;
	private sig: string | undefined;
	private cached: StateRead | undefined;

	constructor(path: string, now: () => number = Date.now) {
		this.path = path;
		this.now = now;
	}

	/** The current state, re-read from disk only when the file changed. */
	read(): StateRead {
		const sig = signature(this.path);
		if (this.cached && sig === this.sig) return this.cached;
		this.sig = sig;
		this.cached = this.load(sig);
		return this.cached;
	}

	private load(sig: string): StateRead {
		if (sig === "missing") return { ok: true, state: emptyState() };
		let state: OtpState | undefined;
		let why = "unexpected shape";
		try {
			state = parseState(JSON.parse(readFileSync(this.path, "utf8")));
		} catch (err) {
			why = (err as Error).message;
		}
		if (state) return { ok: true, state };
		const since = new Date(this.now()).toISOString();
		console.error(`gh-broker: OTP state file ${this.path} is unreadable or corrupt (${why}); failing closed: every tool except otp_status is locked for every user until "gh-broker otp unlock" rewrites it`);
		return { ok: false, since };
	}

	/**
	 * Persist `state` atomically. On success the cache holds the new state; on failure the
	 * cache still holds it (so in-process counters keep counting) and the error is thrown,
	 * so the caller can refuse anything that depends on the write having landed.
	 */
	write(state: OtpState): void {
		this.cached = { ok: true, state };
		const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
		let written: string;
		try {
			const fd = openSync(tmp, "wx", 0o600);
			try {
				writeSync(fd, `${JSON.stringify(state, null, "\t")}\n`);
				fsyncSync(fd);
				// The signature of this file, taken now: the rename keeps its inode and mtime. Taking it
				// after the rename could pick up a CLI write that landed in between and treat it as ours.
				const st = fstatSync(fd);
				written = `${st.ino}:${st.mtimeMs}:${st.size}`;
			} finally {
				closeSync(fd);
			}
			renameSync(tmp, this.path);
		} catch (err) {
			try {
				unlinkSync(tmp);
			} catch {
				/* the temp file was never created */
			}
			this.sig = signature(this.path); // keep serving the in-memory state while the file is unchanged
			throw new Error(`OTP state could not be saved to ${this.path}: ${(err as Error).message}`);
		}
		this.sig = written;
		syncDir(dirname(this.path));
	}
}

/** fsync the directory so the rename itself is durable. */
function syncDir(dir: string): void {
	try {
		const fd = openSync(dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		/* best-effort: the file itself is already synced and renamed into place */
	}
}
