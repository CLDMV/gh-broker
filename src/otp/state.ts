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
 * The OTP gate's persistent state: the last accepted TOTP step, the bad-code counter and
 * the lockouts. The daemon writes it; the root CLI (`gh-broker otp unlock`) edits it.
 *
 * - Written atomically: a temp file in the same directory (mode 0600), fsync, rename.
 * - Re-read whenever the file's inode, mtime or size changed since the last read (one
 *   stat per call), so the CLI's edits apply on the next call without a restart.
 * - A missing file is the all-zero state. A file that can't be read or parsed, or that
 *   doesn't have the expected shape, fails closed: it reads as corrupt, which the gate
 *   treats as a hard lock, so tampering with the file can never unlock anything.
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export interface HardLock {
	since: string;
	lockouts: number;
}

export interface OtpState {
	version: 1;
	/** Highest TOTP step that opened a window; a code at or below it can't open another. */
	lastAcceptedStep: number;
	/** Bad codes since the last accepted code or the last short lockout. */
	failures: number;
	/** ISO end of the current short lockout, or null. */
	lockedUntil: string | null;
	/** ISO start times of short lockouts, pruned to the last 24 h on every write. */
	lockouts: string[];
	hardLock: HardLock | null;
}

/** What a read returns: the state, or a marker that the file is unusable. */
export type StateRead = { ok: true; state: OtpState } | { ok: false; since: string };

export function emptyState(): OtpState {
	return { version: 1, lastAcceptedStep: 0, failures: 0, lockedUntil: null, lockouts: [], hardLock: null };
}

const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Validate a parsed state file. Unknown extra keys are ignored. */
export function parseState(raw: unknown): OtpState | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const s = raw as Record<string, unknown>;
	if (s.version !== 1 || !isCount(s.lastAcceptedStep) || !isCount(s.failures)) return undefined;
	if (s.lockedUntil !== null && !isIso(s.lockedUntil)) return undefined;
	if (!Array.isArray(s.lockouts) || !s.lockouts.every(isIso)) return undefined;
	let hardLock: HardLock | null = null;
	if (s.hardLock !== null) {
		const h = s.hardLock as Record<string, unknown> | undefined;
		if (typeof h !== "object" || !isIso(h.since) || !isCount(h.lockouts)) return undefined;
		hardLock = { since: h.since, lockouts: h.lockouts };
	}
	return { version: 1, lastAcceptedStep: s.lastAcceptedStep, failures: s.failures, lockedUntil: s.lockedUntil, lockouts: [...s.lockouts], hardLock };
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
		console.error(`gh-broker: OTP state file ${this.path} is unreadable or corrupt (${why}); failing closed: every tool except otp_status is locked until "gh-broker otp unlock" rewrites it`);
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
		try {
			const fd = openSync(tmp, "wx", 0o600);
			try {
				writeSync(fd, `${JSON.stringify(state, null, "\t")}\n`);
				fsyncSync(fd);
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
		syncDir(dirname(this.path));
		this.sig = signature(this.path);
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
