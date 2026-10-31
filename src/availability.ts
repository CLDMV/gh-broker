/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/availability.ts
 *	@Date: 2026-10-31T12:09:43-07:00 (1793473783)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-31T12:12:11-07:00 (1793473931)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Tools that depend on an optional integration. An allowlisted tool whose integration isn't
 * configured, or whose credential isn't stored, is unavailable: the catalog doesn't advertise
 * it and the router refuses it like a tool that isn't allowed. Everything else keeps working.
 * Catalog and router both ask here, so they can never disagree.
 */

import type { Config, SecretStore, ToolRule } from "./types.ts";

/** Why `rule` can't be used on this broker, or undefined when it can. */
export function unavailableReason(rule: ToolRule, config: Config, secrets: SecretStore): string | undefined {
	if (rule.name === "npm_scaffold") {
		if (!config.npm) return "the npm integration is not configured (enable it with the installer's --npm)";
		if (!secrets.has(config.npm.token)) return `its credential "${config.npm.token.replace(/^cred:/, "")}" is not stored (re-run the installer with --npm)`;
	}
	return undefined;
}
