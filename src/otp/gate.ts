/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/otp/gate.ts
 *	@Date: 2026-11-01T20:43:25-08:00 (1793594605)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-02T21:27:13-08:00 (1793683633)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The OTP gate (#143). A gated call carries a TOTP code from the user's authenticator in
 * `otp`. The first valid, unused code opens a window: for `windowSeconds` (fixed, no
 * renewal) every gated tool runs when it carries that same code. Several windows can be
 * open at once, one per code. Windows live in memory only, so a restart closes them; the
 * last accepted TOTP step is persisted, so a code from before the restart can't reopen one.
 *
 * Every call comes from a known agent user (each has its own socket, see server.ts), so
 * windows and counters are per user: a window only serves the user who opened it, even for the
 * same code. The last accepted step stays global, since there is one seed: once any user has
 * spent a code, nobody can open a window with it.
 *
 * Guessing: `maxFailures` bad codes start a short lockout of `lockoutSeconds` for that user;
 * `maxLockouts` short lockouts in a rolling 24 h set a hard lock that blocks every tool except
 * otp_status for that user until root runs `gh-broker otp unlock <user>`.
 *
 * Nothing here ever logs or returns a code, the seed, or anything derived from them except
 * the window id: an HMAC of the code under a per-process random key, which correlates audit
 * lines within one run and means nothing outside it.
 */

import { createHmac, randomBytes } from "node:crypto";
import { audit } from "../audit.ts";
import { hostname } from "node:os";
import type { Config, SecretStore } from "../types.ts";
import { OTP_ARG, isGated, otpSettings, readSeed, type OtpSettings } from "./policy.ts";
import { isEnabled } from "../availability.ts";
import { OtpStateFile, emptyUser, userState, type HardLock, type OtpState, type UserState } from "./state.ts";
import { matchStep, safeEqual } from "./totp.ts";

export type OtpOutcome = "window" | "opened" | "refused" | "locked" | "hard-locked";

/** The audit fields a gated (or hard-locked) call adds to its log line. */
export interface OtpAudit {
	otp: OtpOutcome;
	window?: string;
	/** When the window closes, on "opened". */
	until?: string;
}

/** A call the gate refused. Its message is safe to return to the agent. */
export class OtpRefusal extends Error {
	readonly audit: OtpAudit;
	constructor(message: string, audit: OtpAudit) {
		super(message);
		this.name = "OtpRefusal";
		this.audit = audit;
	}
}

export const UNLOCK_COMMAND = "sudo gh-broker otp unlock";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OtpGateOptions {
	/** Clock, in ms. Defaults to Date.now. */
	now?: () => number;
	/** Host name used in messages and otp_status. Defaults to os.hostname(). */
	host?: string;
}

interface OpenWindow {
	user: string;
	code: string;
	expiresAt: number;
	id: string;
}

/** The root command that clears `user`'s counters and locks. */
/** What clears a corrupt state file (a single-user unlock refuses one). */
export const UNLOCK_ALL_COMMAND = "sudo gh-broker otp unlock --all";

export function unlockCommand(user: string): string {
	return `${UNLOCK_COMMAND} ${user}`;
}

export class OtpGate {
	private readonly config: Config;
	private readonly secrets: SecretStore;
	private readonly settings: OtpSettings;
	private readonly now: () => number;
	private readonly host: string;
	private readonly state: OtpStateFile;
	/** Per-process key for window ids. */
	private readonly idKey = randomBytes(32);
	private windows: OpenWindow[] = [];
	/** Users whose latest bad-code count is only in memory because the state file couldn't be written. */
	private readonly unsaved = new Set<string>();

	constructor(config: Config, secrets: SecretStore, options: OtpGateOptions = {}) {
		this.config = config;
		this.secrets = secrets;
		this.settings = otpSettings(config);
		this.now = options.now ?? Date.now;
		this.host = options.host ?? hostname();
		this.state = new OtpStateFile(this.settings.statePath, this.now);
	}

	/** Whether the gate runs at all. Without config.otp no state file is ever touched. */
	get enabled(): boolean {
		return this.config.otp !== undefined;
	}

	/**
	 * The hard-lock refusal for `user`, if that user is hard-locked (or the state file is
	 * unusable, which locks everyone). The router checks this on every call except otp_status.
	 */
	hardLockRefusal(user: string): OtpRefusal | undefined {
		if (!this.enabled) return undefined;
		const read = this.state.read();
		if (!read.ok) {
			// An unusable state file locks everyone, and only `unlock --all` rewrites it.
			return new OtpRefusal(
				`gh-broker is locked for every agent: its OTP state file is unreadable or corrupt (since ${read.since}). Ask the user to run "${UNLOCK_ALL_COMMAND}" on ${this.host}. Nothing was run.`,
				{ otp: "hard-locked" }
			);
		}
		const since = userState(read.state, user).hardLock?.since;
		if (since === undefined) return undefined;
		return new OtpRefusal(
			`gh-broker is locked for ${user} after repeated bad OTP codes (since ${since}). Ask the user to run "${unlockCommand(user)}" on ${this.host}. Nothing was run.`,
			{ otp: "hard-locked" }
		);
	}

	/**
	 * Decide `user`'s call to the gated tool `tool` carrying `code` (the raw `otp` argument).
	 * Returns the audit fields when the call may run; throws OtpRefusal when it may not.
	 * Only call this after hardLockRefusal() and the availability check passed (OTP is set up).
	 */
	authorize(tool: string, code: unknown, user: string): OtpAudit {
		const now = this.now();
		const read = this.state.read();
		// hardLockRefusal() ran first, so this is normally clear; re-check anyway (authorize is
		// public) and fail closed.
		if (!read.ok || userState(read.state, user).hardLock) throw this.hardLockRefusal(user)!;
		const state = read.state;
		const mine = userState(state, user);

		const lockedUntil = mine.lockedUntil ? Date.parse(mine.lockedUntil) : 0;
		if (lockedUntil > now) {
			const minutes = Math.max(1, Math.ceil((lockedUntil - now) / 60000));
			throw new OtpRefusal(`OTP is locked for ${minutes} more minute(s) after too many bad codes. Nothing was run.`, { otp: "locked" });
		}

		const unsavedRefusal = (): OtpRefusal => new OtpRefusal(`OTP could not be checked: the broker could not save its OTP state. Nothing was run.`, { otp: "refused" });
		// A bad code this user sent couldn't be saved (disk full, say): check nothing more for them
		// until the counters are on disk, so a restart can't hand out a fresh guess budget.
		if (this.unsaved.has(user)) {
			try {
				this.state.write(this.compact(state, now));
				this.unsaved.delete(user);
			} catch (err) {
				console.error(`gh-broker: ${(err as Error).message}`);
				throw unsavedRefusal();
			}
		}

		const refusal = (): OtpRefusal =>
			new OtpRefusal(`OTP required for ${tool}: ask the user for a current code from their authenticator app and pass it as "${OTP_ARG}". Nothing was run.`, { otp: "refused" });

		if (code === undefined || code === null || code === "") throw refusal(); // a missing code is not a failure
		// A client that sends the code as a JSON number (and so drops a leading zero) gets it back
		// as six digits. Any other non-string is a malformed call, refused without counting.
		if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 999999) code = String(code).padStart(6, "0");
		if (typeof code !== "string") throw refusal();

		this.windows = this.windows.filter((w) => w.expiresAt > now);
		let hit: OpenWindow | undefined;
		// Only this user's windows: a code another agent opened a window with is no use here.
		for (const w of this.windows) if (w.user === user && safeEqual(w.code, code)) hit = w; // no early exit
		if (hit) return { otp: "window", window: hit.id };

		const step = matchStep((readSeed(this.config, this.secrets) as { key: Buffer }).key, code, now);
		if (step !== undefined && step > state.lastAcceptedStep) {
			// Persist the step before anything runs: if it can't be saved, a restart could let
			// this code open a second window, so refuse instead.
			try {
				this.state.write(this.compact({ ...state, lastAcceptedStep: step, users: { ...state.users, [user]: { ...mine, failures: 0 } } }, now));
			} catch (err) {
				console.error(`gh-broker: ${(err as Error).message}`);
				throw unsavedRefusal();
			}
			const id = createHmac("sha256", this.idKey).update(`${user}\0${code}`).digest("hex").slice(0, 16);
			const expiresAt = now + this.settings.windowSeconds * 1000;
			this.windows.push({ user, code, expiresAt, id });
			return { otp: "opened", window: id, until: new Date(expiresAt).toISOString() };
		}

		// A real code whose step is already spent (reused, or spent by an unlock) is refused but isn't
		// a guess, so it doesn't count toward a lockout.
		if (step !== undefined) throw refusal();
		this.recordFailure(tool, state, mine, user, now);
		throw refusal();
	}

	/** Count one bad code for `user`, starting a short lockout (and maybe the hard lock) at the limit. */
	private recordFailure(tool: string, state: OtpState, mine: UserState, user: string, now: number): void {
		const next = { ...mine, lockouts: mine.lockouts.filter((t) => Date.parse(t) > now - DAY_MS) };
		next.failures += 1;
		if (next.failures >= this.settings.maxFailures) {
			const at = new Date(now).toISOString();
			next.failures = 0;
			next.lockedUntil = new Date(now + this.settings.lockoutSeconds * 1000).toISOString();
			next.lockouts.push(at);
			if (next.lockouts.length >= this.settings.maxLockouts) next.hardLock = { since: at, lockouts: next.lockouts.length };
			audit(
				next.hardLock
					? { tool, user, decision: "deny", otp: "hard-lock", detail: `${next.lockouts.length} lockouts in 24 h; every tool except otp_status is refused until "${unlockCommand(user)}"` }
					: { tool, user, decision: "deny", otp: "lockout", until: next.lockedUntil, detail: `${this.settings.maxFailures} bad codes` }
			);
		}
		try {
			this.state.write(this.compact({ ...state, users: { ...state.users, [user]: next } }, now));
		} catch (err) {
			// The counters still advance in memory and the refusal stands; authorize() refuses this
			// user's gated calls until they can be saved.
			this.unsaved.add(user);
			console.error(`gh-broker: ${(err as Error).message}`);
		}
	}

	/**
	 * `state` tidied for a write: every user's lockouts pruned to the last 24 h, expired short
	 * lockouts cleared, and users left with nothing to record dropped.
	 */
	private compact(state: OtpState, now: number): OtpState {
		const users: Record<string, UserState> = {};
		for (const [name, u] of Object.entries(state.users)) {
			const lockouts = u.lockouts.filter((t) => Date.parse(t) > now - DAY_MS);
			const lockedUntil = u.lockedUntil && Date.parse(u.lockedUntil) > now ? u.lockedUntil : null;
			if (u.failures === 0 && lockedUntil === null && lockouts.length === 0 && u.hardLock === null) continue;
			users[name] = { failures: u.failures, lockedUntil, lockouts, hardLock: u.hardLock };
		}
		return { ...state, users };
	}

	/**
	 * The otp_status report for `user`: their own windows and counters, plus every hard-locked
	 * user. Never a code, the seed, or anything derived from them.
	 */
	status(user: string): Record<string, unknown> {
		const now = this.now();
		// A disabled tool can't be called at all, so it isn't listed as needing a code.
		const gatedTools = this.config.tools.filter((t) => isGated(t) && isEnabled(t)).map((t) => t.name);
		let mine = emptyUser();
		let hardLock: HardLock | null = null;
		let lockedUsers: Array<{ user: string; since: string; lockouts: number; unlockCommand: string }> = [];
		let corrupt = false;
		if (this.enabled) {
			const read = this.state.read();
			if (read.ok) {
				mine = userState(read.state, user);
				hardLock = mine.hardLock;
				lockedUsers = Object.entries(read.state.users)
					.filter(([, u]) => u.hardLock)
					.map(([name, u]) => ({ user: name, since: u.hardLock!.since, lockouts: u.hardLock!.lockouts, unlockCommand: unlockCommand(name) }));
			} else {
				// An unusable file locks every user; the caller is the one we can name.
				hardLock = { since: read.since, lockouts: 0 };
				corrupt = true;
				lockedUsers = [{ user, since: read.since, lockouts: 0, unlockCommand: UNLOCK_ALL_COMMAND }];
			}
		}
		const open = this.windows.filter((w) => w.user === user && w.expiresAt > now);
		const next = open.length ? Math.min(...open.map((w) => w.expiresAt)) : undefined;
		const lockedUntil = mine.lockedUntil && Date.parse(mine.lockedUntil) > now ? mine.lockedUntil : null;
		return {
			configured: !("problem" in readSeed(this.config, this.secrets)),
			user,
			gatedTools,
			windowSeconds: this.settings.windowSeconds,
			openWindows: open.length,
			nextWindowExpiresAt: next === undefined ? null : new Date(next).toISOString(),
			failures: mine.failures,
			maxFailures: this.settings.maxFailures,
			lockedUntil,
			lockoutsLast24h: mine.lockouts.filter((t) => Date.parse(t) > now - DAY_MS).length,
			maxLockouts: this.settings.maxLockouts,
			hardLock,
			unlockCommand: corrupt ? UNLOCK_ALL_COMMAND : unlockCommand(user),
			lockedUsers,
			host: this.host
		};
	}
}

/** Window length for tool descriptions, e.g. "5 minutes" or "90 seconds". */
export function windowText(seconds: number): string {
	if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
	return `${seconds} seconds`;
}
