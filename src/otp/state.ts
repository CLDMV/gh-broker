/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/otp/state.ts
 *	@Date: 2026-11-01T20:43:25-08:00 (1793594605)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T20:43:25-08:00 (1793594605)
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
 */

import { closeSync, fstatSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { isAgentUser } from "../agents.ts";

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

/** What a read returns: the state, or a marker that the file is unusable. */
export type StateRead = { ok: true; state: OtpState } | { ok: false; since: string };

export function emptyState(): OtpState {
	return { version: 1, lastAcceptedStep: 0, users: {} };
}

export function emptyUser(): UserState {
	return { failures: 0, lockedUntil: null, lockouts: [], hardLock: null };
}

/** `user`'s counters (a fresh copy), all zero/null when the user has no entry. */
export function userState(state: OtpState, user: string): UserState {
	const u = Object.hasOwn(state.users, user) ? state.users[user]! : emptyUser();
	return { ...u, lockouts: [...u.lockouts] };
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

export class OtpStateFile {
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
