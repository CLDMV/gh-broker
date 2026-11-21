/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/core/otp-policy.ts
 *	@Date: 2026-11-01T20:43:25-08:00 (1793594605)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T14:53:38-08:00 (1794696818)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Which tools need a broker OTP (design #175 §1's otp/policy.ts split row: the gating
 * half), plus the config-derived OTP limit settings (slice 6: re-homed here from the
 * daemon's half — pure mapping over config.otp, no host knowledge). Catalog, router and
 * availability all ask here, so the advertised schema, the availability check and the
 * gate itself can never disagree about a tool. The rest of the old module stays host:
 * the statePath default (the daemon's /var/lib location) and the seed checks —
 * readSeed/otpSetupProblem — live in src/otp/policy.ts, which re-exports this half from
 * the old path and re-adds statePath to the settings shape.
 */

import type { Config, OtpConfig, ToolRule } from "./types.ts";

/** The status verb. Never gated and never blocked by a lock, so a locked agent can still report. */
export const OTP_STATUS = "otp_status";

/** The argument a gated call carries its code in (npm_scaffold's own npm code is `npm_otp`). */
export const OTP_ARG = "otp";

/**
 * Tools gated when config.tools[i].otp doesn't say otherwise (#146): each one can publish,
 * merge, release or undo something under the user's name. Every other tool defaults to ungated.
 */
export const DEFAULT_GATED: ReadonlySet<string> = new Set<string>([
	"create_repository",
	"fork_repository",
	"merge_pull_request",
	"pull_request_review_write",
	"actions_run_trigger",
	"label_write",
	"delete_branch",
	"dismiss_alert",
	// Disabled by default too (src/availability.ts); gated once enabled.
	"create_pull_request_with_copilot",
	"assign_copilot_to_issue",
	"assign_copilot_to_issue_with_intent"
]);

/** Whether `rule` needs a broker OTP: its own `otp` flag, else the built-in default. */
export function isGated(rule: ToolRule): boolean {
	if (rule.name === OTP_STATUS) return false;
	return rule.otp ?? DEFAULT_GATED.has(rule.name);
}

/** Window length for tool descriptions, e.g. "5 minutes" or "90 seconds". */
export function windowText(seconds: number): string {
	if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
	return `${seconds} seconds`;
}

/**
 * The OTP limits' defaults (config.otp's four knobs). No statePath: where lock state is
 * persisted is host knowledge (the daemon's default lives in src/otp/policy.ts; a
 * library host keeps its own store), so it never enters the library's settings shape.
 */
export const OTP_DEFAULTS = {
	windowSeconds: 300,
	maxFailures: 5,
	lockoutSeconds: 600,
	maxLockouts: 3
} as const;

/** config.otp's limits with every default filled in (statePath excluded — host knowledge). */
export type OtpSettings = Required<Omit<OtpConfig, "seed" | "statePath">>;

/** config.otp's limits with every default filled in (defaults alone when there is no config.otp). */
export function otpSettings(config: Pick<Config, "otp">): OtpSettings {
	const o = config.otp;
	return {
		windowSeconds: o?.windowSeconds ?? OTP_DEFAULTS.windowSeconds,
		maxFailures: o?.maxFailures ?? OTP_DEFAULTS.maxFailures,
		lockoutSeconds: o?.lockoutSeconds ?? OTP_DEFAULTS.lockoutSeconds,
		maxLockouts: o?.maxLockouts ?? OTP_DEFAULTS.maxLockouts
	};
}
