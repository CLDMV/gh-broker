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
 * half). Catalog, router and availability all ask here, so the advertised schema, the
 * availability check and the gate itself can never disagree about a tool. The daemon's
 * half of the old module — OTP_DEFAULTS, otpSettings, readSeed, otpSetupProblem — stays
 * in src/otp/policy.ts, which re-exports this gating half from the old path.
 */

import type { ToolRule } from "./types.ts";

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
