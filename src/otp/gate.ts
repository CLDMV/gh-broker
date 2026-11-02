/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/otp/gate.ts
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
 * The OTP gate (#143). A gated call carries a TOTP code from the user's authenticator in
 * `otp`. The first valid, unused code opens a window: for `windowSeconds` (fixed, no
 * renewal) every gated tool runs when it carries that same code. Several windows can be
 * open at once, one per code. Windows live in memory only, so a restart closes them; the
 * last accepted TOTP step is persisted, so a code from before the restart can't reopen one.
 *
 * Guessing: `maxFailures` bad codes start a short lockout of `lockoutSeconds`; `maxLockouts`
 * short lockouts in a rolling 24 h set a hard lock that blocks every tool except otp_status
 * until root runs `gh-broker otp unlock`. Counters are broker-wide (there is no caller
 * identity on the socket yet, see #145).
 *
 * Nothing here ever logs or returns a code, the seed, or anything derived from them except
 * the window id: an HMAC of the code under a per-process random key, which correlates audit
 * lines within one run and means nothing outside it.
 */

import { createHmac, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { Config, SecretStore } from "../types.ts";
import { OTP_ARG, isGated, otpSettings, readSeed, type OtpSettings } from "./policy.ts";
import { OtpStateFile, type OtpState } from "./state.ts";
import { matchStep, safeEqual } from "./totp.ts";

export type OtpOutcome = "window" | "opened" | "refused" | "locked" | "hard-locked";

/** The audit fields a gated (or hard-locked) call adds to its log line. */
export interface OtpAudit {
	otp: OtpOutcome;
	window?: string;
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
	code: string;
	expiresAt: number;
	id: string;
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
	 * The hard-lock refusal, if the broker is hard-locked (or its state file is unusable).
	 * The router checks this on every call except otp_status.
	 */
	hardLockRefusal(): OtpRefusal | undefined {
		if (!this.enabled) return undefined;
		const since = this.hardLockSince();
		if (since === undefined) return undefined;
		return new OtpRefusal(`gh-broker is locked after repeated bad OTP codes (since ${since}). Ask the user to run "${UNLOCK_COMMAND}" on ${this.host}. Nothing was run.`, { otp: "hard-locked" });
	}

	private hardLockSince(): string | undefined {
		const read = this.state.read();
		if (!read.ok) return read.since;
		return read.state.hardLock?.since;
	}

	/**
	 * Decide a call to the gated tool `tool` carrying `code` (the raw `otp` argument).
	 * Returns the audit fields when the call may run; throws OtpRefusal when it may not.
	 * Only call this after hardLockRefusal() and the availability check passed (OTP is set up).
	 */
	authorize(tool: string, code: unknown): OtpAudit {
		const now = this.now();
		const read = this.state.read();
		// hardLockRefusal() ran first, so the file is usable; re-check anyway in case it
		// changed in between, and fail closed.
		if (!read.ok || read.state.hardLock) throw this.hardLockRefusal()!;
		const state = read.state;

		const lockedUntil = state.lockedUntil ? Date.parse(state.lockedUntil) : 0;
		if (lockedUntil > now) {
			const minutes = Math.max(1, Math.ceil((lockedUntil - now) / 60000));
			throw new OtpRefusal(`OTP is locked for ${minutes} more minute(s) after too many bad codes. Nothing was run.`, { otp: "locked" });
		}

		const refusal = (): OtpRefusal =>
			new OtpRefusal(`OTP required for ${tool}: ask the user for a current code from their authenticator app and pass it as "${OTP_ARG}". Nothing was run.`, { otp: "refused" });

		if (code === undefined || code === null || code === "") throw refusal(); // a missing code is not a failure

		this.windows = this.windows.filter((w) => w.expiresAt > now);
		if (typeof code === "string") {
			let hit: OpenWindow | undefined;
			for (const w of this.windows) if (safeEqual(w.code, code)) hit = w; // no early exit
			if (hit) return { otp: "window", window: hit.id };

			const step = matchStep((readSeed(this.config, this.secrets) as { key: Buffer }).key, code, now);
			if (step !== undefined && step > state.lastAcceptedStep) {
				// Persist the step before anything runs: if it can't be saved, a restart could let
				// this code open a second window, so refuse instead.
				try {
					this.state.write({ ...this.pruned(state, now), lastAcceptedStep: step, failures: 0 });
				} catch (err) {
					console.error(`gh-broker: ${(err as Error).message}`);
					throw new OtpRefusal(`OTP could not be checked: the broker could not save its OTP state. Nothing was run.`, { otp: "refused" });
				}
				const id = createHmac("sha256", this.idKey).update(code).digest("hex").slice(0, 16);
				this.windows.push({ code, expiresAt: now + this.settings.windowSeconds * 1000, id });
				return { otp: "opened", window: id };
			}
		}

		this.recordFailure(state, now);
		throw refusal();
	}

	/** Count one bad code, starting a short lockout (and maybe the hard lock) at the limit. */
	private recordFailure(state: OtpState, now: number): void {
		const next = this.pruned(state, now);
		next.failures += 1;
		if (next.failures >= this.settings.maxFailures) {
			const at = new Date(now).toISOString();
			next.failures = 0;
			next.lockedUntil = new Date(now + this.settings.lockoutSeconds * 1000).toISOString();
			next.lockouts.push(at);
			if (next.lockouts.length >= this.settings.maxLockouts) next.hardLock = { since: at, lockouts: next.lockouts.length };
			console.error(
				next.hardLock
					? `gh-broker: OTP hard lock after ${next.lockouts.length} lockouts in 24 h; every tool except otp_status is refused until "${UNLOCK_COMMAND}"`
					: `gh-broker: OTP locked until ${next.lockedUntil} after ${this.settings.maxFailures} bad codes`
			);
		}
		try {
			this.state.write(next);
		} catch (err) {
			// The counters still advance in memory; the refusal stands either way.
			console.error(`gh-broker: ${(err as Error).message}`);
		}
	}

	/**
	 * A copy of `state` for the next write, with lockouts older than 24 h dropped. Writes only
	 * happen past the short-lockout check in authorize(), so any lockedUntil here has expired.
	 */
	private pruned(state: OtpState, now: number): OtpState {
		return { ...state, lockedUntil: null, lockouts: state.lockouts.filter((t) => Date.parse(t) > now - DAY_MS) };
	}

	/** The otp_status report. Never a code, the seed, or anything derived from them. */
	status(): Record<string, unknown> {
		const now = this.now();
		const gatedTools = this.config.tools.filter(isGated).map((t) => t.name);
		let state: OtpState | undefined;
		let hardLock: { since: string; lockouts: number } | null = null;
		if (this.enabled) {
			const read = this.state.read();
			if (read.ok) {
				state = read.state;
				hardLock = state.hardLock;
			} else {
				hardLock = { since: read.since, lockouts: 0 };
			}
		}
		const open = this.windows.filter((w) => w.expiresAt > now);
		const next = open.length ? Math.min(...open.map((w) => w.expiresAt)) : undefined;
		const lockedUntil = state?.lockedUntil && Date.parse(state.lockedUntil) > now ? state.lockedUntil : null;
		return {
			configured: !("problem" in readSeed(this.config, this.secrets)),
			gatedTools,
			windowSeconds: this.settings.windowSeconds,
			openWindows: open.length,
			nextWindowExpiresAt: next === undefined ? null : new Date(next).toISOString(),
			failures: state?.failures ?? 0,
			maxFailures: this.settings.maxFailures,
			lockedUntil,
			lockoutsLast24h: state ? state.lockouts.filter((t) => Date.parse(t) > now - DAY_MS).length : 0,
			maxLockouts: this.settings.maxLockouts,
			hardLock,
			unlockCommand: UNLOCK_COMMAND,
			host: this.host
		};
	}
}

/** Window length for tool descriptions, e.g. "5 minutes" or "90 seconds". */
export function windowText(seconds: number): string {
	if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
	return `${seconds} seconds`;
}
