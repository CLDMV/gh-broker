/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/availability.ts
 *	@Date: 2026-10-31T12:09:43-07:00 (1793473783)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T11:06:17-08:00 (1794683177)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Tools that depend on an optional integration. An allowlisted tool whose integration isn't
 * configured, or whose credential isn't stored, is unavailable: the catalog doesn't advertise
 * it and the router refuses it like a tool that isn't allowed. Everything else keeps working.
 * Gated tools (src/otp/policy.ts) are unavailable until OTP is set up, and a tool that's disabled
 * (by default or by its `enabled` flag) is unavailable until enabled. Catalog and router both ask
 * here, so they can never disagree.
 */

import type { Config, ToolRule } from "./types.ts";
import { ghcrCredRefs } from "./verbs/ghcr/config.ts";
import { isGated } from "./otp/policy.ts";

const GHCR_TOOLS = new Set(["ghcr_push", "ghcr_push_status", "ghcr_tags"]);

/**
 * Shipped but off until a tool entry says `"enabled": true`. Copilot's coding agent writes code
 * into a repo outside `git`, so it's opt-in; once enabled it's also gated by default.
 */
export const DEFAULT_DISABLED: ReadonlySet<string> = new Set(["create_pull_request_with_copilot", "assign_copilot_to_issue", "assign_copilot_to_issue_with_intent"]);

/** Whether `rule` is served: its own `enabled` flag, else the built-in default. */
export function isEnabled(rule: ToolRule): boolean {
	return rule.enabled ?? !DEFAULT_DISABLED.has(rule.name);
}

/**
 * Why `rule` can't be used on this broker, or undefined when it can.
 *
 * Credentials come through the injected capability predicate `has` (design #175 §2a) —
 * the daemon passes `(ref) => secrets.has(ref)`; the library never sees a SecretStore.
 * The OTP setup check is injected too (`otpProblem`): whether the gate is ready is host
 * knowledge (the daemon's check decodes the stored seed, which a bare `has` cannot do —
 * without the injection that check would silently lose the invalid-seed case and change
 * which tools a broker with a corrupt seed advertises).
 */
export function unavailableReason(rule: ToolRule, config: Config, has: (ref: string) => boolean, otpProblem: (config: Config) => string | undefined): string | undefined {
	if (!isEnabled(rule)) {
		return DEFAULT_DISABLED.has(rule.name) && rule.enabled === undefined
			? `it is disabled by default; set "enabled": true on its entry in config.tools to turn it on`
			: `it is disabled in config.tools ("enabled": false)`;
	}
	if (rule.name === "npm_scaffold") {
		if (!config.npm) return "the npm integration is not configured (enable it with the installer's --npm)";
		if (!has(config.npm.token)) return `its credential "${config.npm.token.replace(/^cred:/, "")}" is not stored (re-run the installer with --npm)`;
	}
	if (GHCR_TOOLS.has(rule.name)) {
		if (!config.ghcr) return "GHCR pushes are not configured (config.ghcr)";
		const refs = ghcrCredRefs(config.ghcr);
		if (!refs.some((ref) => has(ref))) {
			return `no GHCR credential is stored (${refs.map((r) => `"${r.replace(/^cred:/, "")}"`).join(", ")}; re-run the installer to add one)`;
		}
	}
	// A gated tool can only run once OTP is set up; until then it's hidden like the others.
	if (isGated(rule)) return otpProblem(config);
	return undefined;
}
