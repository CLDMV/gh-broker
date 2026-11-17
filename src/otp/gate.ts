/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/otp/gate.ts
 *	@Date: 2026-11-01T20:43:25-08:00 (1793594605)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T11:02:53-08:00 (1794682973)
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
 * The lockout machine itself is `@cldmv/lib-otp`'s (design #175): this file is the daemon's
 * host shell over it. The machine is identity-free and store-free — it sees one person's
 * record and returns reason codes; everything identity-shaped (the users map, the file, the
 * per-process code↔window map, the refusal prose, the audit rows) stays here. The machine's
 * windows carry only `{ id, expiresAt }`; the plaintext codes live in this file's per-person
 * map and never reach machine state or disk.
 *
 * Nothing here ever logs or returns a code, the seed, or anything derived from them except
 * the window id: an HMAC of the code under a per-process random key, which correlates audit
 * lines within one run and means nothing outside it.
 */

import { createHmac, randomBytes } from "node:crypto";
import { audit } from "../audit.ts";
import { hostname } from "node:os";
import { OtpRefusal, type AuditEntry, type Config, type OtpAudit, type OtpGate as OtpGateSeam, type SecretStore } from "../types.ts";
import { OTP_ARG, isGated, otpSettings, readSeed, windowText, type OtpSettings } from "./policy.ts";
import { isEnabled } from "../availability.ts";
import { OtpStateFile, emptyUser, personOf, userState, type HardLock, type MachinePerson, type OtpState, type UserState } from "./state.ts";
import {
	lockStatus,
	parseOtpOptions,
	safeEqual,
	stepOtp,
	verifyCode,
	STEP_SECONDS
} from "@cldmv/lib-otp";

// The machine's vocabulary, derived from the package's function types (its index doesn't
// re-export the type aliases itself).
type MachineOutcome = NonNullable<ReturnType<typeof stepOtp>["outcome"]>;
type MachineConfig = ReturnType<typeof parseOtpOptions>;

// windowText is pure prose formatting and lives in the gating-policy module (src/otp/policy.ts);
// the catalog imports it from there, so this file's fs/audit/os imports stay out of its graph.
// Re-exported so the old import path keeps working.
export { windowText };

// OtpOutcome/OtpAudit/OtpRefusal are the gate's shared vocabulary and live in src/types.ts
// (next to the OtpGate seam interface the Router consumes, design #175 §2e); re-exported
// so the old import path keeps working.
export { OtpRefusal } from "../types.ts";
export type { OtpAudit, OtpOutcome } from "../types.ts";

export const UNLOCK_COMMAND = "sudo gh-broker otp unlock";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OtpGateOptions {
	/** Clock, in ms. Defaults to Date.now. */
	now?: () => number;
	/** Host name used in messages and otp_status. Defaults to os.hostname(). */
	host?: string;
}

/** The root command that clears `user`'s counters and locks. */
/** What clears a corrupt state file (a single-user unlock refuses one). */
export const UNLOCK_ALL_COMMAND = "sudo gh-broker otp unlock --all";

export function unlockCommand(user: string): string {
	return `${UNLOCK_COMMAND} ${user}`;
}

/**
 * The machine config the daemon runs, mapped explicitly from config.otp's validated fields
 * (design §2g — no raw config.otp pass-through): today's fixed numbers (6 digits, SHA1, 30 s
 * steps, ±1 skew), no lockout escalation, and the hard lock keyed to maxLockouts short
 * lockouts in a rolling 24 h.
 */
export function machineConfig(settings: OtpSettings): MachineConfig {
	return parseOtpOptions({
		digits: 6,
		periodSeconds: STEP_SECONDS,
		algorithm: "SHA1",
		skewSteps: 1,
		windowSeconds: settings.windowSeconds,
		maxFailures: settings.maxFailures,
		failureCounting: { mode: "since-accept-or-lockout" },
		lockoutSeconds: settings.lockoutSeconds,
		lockoutEscalation: { factor: 1, maxSeconds: settings.lockoutSeconds },
		spendOnUnlock: true,
		hardLockEnabled: true,
		hardLockTrigger: { lockouts: settings.maxLockouts, windowMs: DAY_MS },
		refuseReused: true,
		windowEnabled: true
	});
}

/**
 * The security row a machine outcome adds to the audit log, or undefined when the per-call
 * row covers it: `locked-out` → the `otp: "lockout"` row, `hard-locked-now` → the
 * `otp: "hard-lock"` row (one row — the hard lock replaces the lockout on that transition).
 * Every other outcome writes no extra row: a plain bad code is covered by the router's call
 * row, and the plain locked/hard-locked refusals (row 10) write none, as before. The host
 * supplies its limits and the unlock command; the row comes before the state write and the
 * router's call row.
 */
export function otpAuditRow(
	tool: string,
	user: string,
	outcome: MachineOutcome,
	opts: { maxFailures: number; unlockCommand: string }
): AuditEntry | undefined {
	if (outcome.reason === "locked-out") {
		return { tool, user, decision: "deny", otp: "lockout", until: outcome.until, detail: `${opts.maxFailures} bad codes` };
	}
	if (outcome.reason === "hard-locked-now") {
		return {
			tool,
			user,
			decision: "deny",
			otp: "hard-lock",
			detail: `${outcome.lockouts} lockouts in 24 h; every tool except otp_status is refused until "${opts.unlockCommand}"`
		};
	}
	return undefined;
}

/** The file's per-user record for a machine state: the machine's memory-tier fields (its windows, the per-person counter and period, failureTimes) never reach disk. */
function userRecord(person: MachinePerson): UserState {
	return {
		failures: person.failures,
		lockedUntil: person.lockedUntil,
		lockouts: [...person.lockouts],
		hardLock: person.hardLock === null ? null : { ...person.hardLock }
	};
}

/** The daemon's concrete gate — the host implementation of the OtpGate seam (src/types.ts). */
export class OtpGate implements OtpGateSeam {
	private readonly config: Config;
	private readonly secrets: SecretStore;
	private readonly settings: OtpSettings;
	/** The machine, built once from config.otp's mapped fields (see machineConfig). */
	private readonly machine: MachineConfig;
	private readonly now: () => number;
	private readonly host: string;
	private readonly state: OtpStateFile;
	/** Per-process key for window ids. */
	private readonly idKey = randomBytes(32);
	/** Each user's open windows by id: the code stays host-side, never in machine state. */
	private readonly windows = new Map<string, Map<string, { code: string; expiresAt: number }>>();
	/** Users whose latest bad-code count is only in memory because the state file couldn't be written. */
	private readonly unsaved = new Set<string>();

	constructor(config: Config, secrets: SecretStore, options: OtpGateOptions = {}) {
		this.config = config;
		this.secrets = secrets;
		this.settings = otpSettings(config);
		this.machine = machineConfig(this.settings);
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
	 * The machine record for `user` at `now`: the file's persisted fields padded with the
	 * memory-tier ones, the global step threaded into the per-person counter (a code is spent
	 * for everyone once any user has spent it), and this user's unexpired windows merged back —
	 * they never reach disk, so the map is their only home between calls.
	 */
	private personFor(state: OtpState, user: string, now: number): MachinePerson {
		const base = personOf(userState(state, user));
		const windows = [...(this.windows.get(user) ?? [])]
			.filter(([, w]) => w.expiresAt > now)
			.map(([id, w]) => ({ id, expiresAt: w.expiresAt }));
		return { ...base, lastCounter: Math.max(state.lastAcceptedStep, base.lastCounter), windows };
	}

	/** The refusal for a call while locked (row 10) or hard-locked, worded as before. */
	private lockRefusal(locked: "locked" | "hard-locked", person: MachinePerson, user: string, now: number): OtpRefusal {
		if (locked === "hard-locked") return this.hardLockRefusal(user)!;
		const minutes = Math.max(1, Math.ceil((Date.parse(person.lockedUntil!) - now) / 60000));
		return new OtpRefusal(`OTP is locked for ${minutes} more minute(s) after too many bad codes. Nothing was run.`, { otp: "locked" });
	}

	/**
	 * Decide `user`'s call to the gated tool `tool` carrying `code` (the raw `otp` argument).
	 * Returns the audit fields when the call may run; throws OtpRefusal when it may not.
	 * Only call this after hardLockRefusal() and the availability check passed (OTP is set up).
	 *
	 * The call protocol is today's, in order (design §3.3b): hard lock → short lockout →
	 * unsaved flush → missing/malformed code → window scan → TOTP match. The machine enforces
	 * its own lock on every event too, so a host that forgets the first check can neither
	 * accept a code nor reuse a window mid-lockout.
	 */
	authorize(tool: string, code: unknown, user: string): OtpAudit {
		const now = this.now();
		const read = this.state.read();
		// hardLockRefusal() ran first, so this is normally clear; re-check anyway (authorize is
		// public) and fail closed.
		if (!read.ok || userState(read.state, user).hardLock) throw this.hardLockRefusal(user)!;
		const state = read.state;
		const person = this.personFor(state, user, now);

		const locked = lockStatus(person, now);
		if (locked !== "clear") throw this.lockRefusal(locked, person, user, now);

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

		// Expired windows drop out of both holdings the gate keeps: this map, and the machine
		// state's windows array rebuilt from it in personFor.
		const mine = this.windows.get(user);
		if (mine) {
			for (const [id, w] of mine) if (w.expiresAt <= now) mine.delete(id);
			if (mine.size === 0) this.windows.delete(user);
		}
		let hit: string | undefined;
		// Only this user's windows: a code another agent opened a window with is no use here.
		for (const [id, w] of this.windows.get(user) ?? []) if (safeEqual(w.code, code)) hit = id; // no early exit
		if (hit) {
			const { outcome } = stepOtp(person, { kind: "window-use", id: hit, now }, this.machine);
			if (outcome?.reason === "window") return { otp: "window", window: hit };
			// Unreachable: the id was matched unexpired above and the lock was clear. Fall through
			// to the TOTP match (which refuses a spent code) rather than inventing an outcome.
		}

		// The stored seed string goes straight to verifyCode: the package decodes it and
		// throws the typed OTP_SEED_INVALID on a bad seed (a config error must never read
		// as "no match"). The old decode→encode round-trip hid behind an unchecked cast —
		// an invalid seed escaped as a raw TypeError (design #175 §5.13). Availability's
		// otpSetupProblem/readSeed still gate the router path; this is the gate's own read.
		const counter = verifyCode(this.secrets.resolve(this.config.otp!.seed).trim(), code, now, this.machine);
		const id = createHmac("sha256", this.idKey).update(`${user}\0${code}`).digest("hex").slice(0, 16);
		const { state: after, outcome } = stepOtp(person, counter === undefined ? { kind: "code-bad", now } : { kind: "code-ok", counter, windowId: id, now }, this.machine);
		switch (outcome?.reason) {
			case "opened": {
				// Persist the step before anything runs: if it can't be saved, a restart could let
				// this code open a second window, so refuse instead.
				try {
					this.state.write(this.compact({ ...state, lastAcceptedStep: outcome.counter, users: { ...state.users, [user]: userRecord(after) } }, now));
				} catch (err) {
					console.error(`gh-broker: ${(err as Error).message}`);
					throw unsavedRefusal();
				}
				// The window exists only once the write landed: a failed write opens no window, and
				// the cached step refuses the retry as spent.
				const map = this.windows.get(user) ?? this.windows.set(user, new Map()).get(user)!;
				map.set(id, { code, expiresAt: Date.parse(outcome.expiresAt!) });
				return { otp: "opened", window: id, until: outcome.expiresAt! };
			}
			case "spent-code":
				// A real code whose step is already spent (reused, or spent by an unlock) is refused but isn't
				// a guess, so it doesn't count toward a lockout.
				throw new OtpRefusal(
					`OTP code for ${tool} is spent (it, or a newer code, was already used): ask the user for the next code from their authenticator app and pass it as "${OTP_ARG}". Nothing was run.`,
					{ otp: "refused" }
				);
			case "bad-code":
			case "locked-out":
			case "hard-locked-now": {
				// The security row (when this code started a lockout or the hard lock) comes before
				// the state write and the router's call row, as before.
				const row = otpAuditRow(tool, user, outcome, { maxFailures: this.settings.maxFailures, unlockCommand: unlockCommand(user) });
				if (row) audit(row);
				try {
					this.state.write(this.compact({ ...state, users: { ...state.users, [user]: userRecord(after) } }, now));
				} catch (err) {
					// The counters still advance in memory and the refusal stands; authorize() refuses this
					// user's gated calls until they can be saved.
					this.unsaved.add(user);
					console.error(`gh-broker: ${(err as Error).message}`);
				}
				throw this.rejection(tool, user, outcome);
			}
			default:
				// Unreachable: the lock was checked above, so the machine cannot return
				// locked/hard-locked here, and every counted outcome is handled above. Fail closed
				// with a fixed string — computing minutes off a null lockedUntil would print NaN.
				throw new OtpRefusal("OTP could not be checked. Nothing was run.", { otp: "refused" });
		}
	}

	/** The refusal for a wrong code, saying how close `user` now is to a lockout. */
	private rejection(tool: string, user: string, outcome: Extract<MachineOutcome, { reason: "bad-code" | "locked-out" | "hard-locked-now" }>): OtpRefusal {
		const lead = `OTP code for ${tool} was not accepted`;
		if (outcome.reason === "hard-locked-now") {
			return new OtpRefusal(`${lead}, and that was the last lockout allowed: gh-broker is now locked for ${user}. Ask the user to run "${unlockCommand(user)}" on ${this.host}. Nothing was run.`, {
				otp: "refused"
			});
		}
		const lockout = windowText(this.settings.lockoutSeconds);
		// The machine resets the count to 0 exactly when this code started a short lockout.
		if (outcome.reason === "locked-out") return new OtpRefusal(`${lead}, and that was too many bad codes: OTP is locked for ${lockout}. Nothing was run.`, { otp: "refused" });
		return new OtpRefusal(
			`${lead} (${outcome.failures} of ${this.settings.maxFailures} bad codes before a lockout of ${lockout}): ask the user for a fresh code from their authenticator app and pass it as "${OTP_ARG}". Nothing was run.`,
			{ otp: "refused" }
		);
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
		const open = [...(this.windows.get(user)?.values() ?? [])].filter((w) => w.expiresAt > now);
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
