/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/router-core.ts
 *	@Date: 2026-11-14T00:00:00-08:00 (1794643200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T11:05:00-08:00 (1794683100)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The library-facing routing seams (design #175 §2a/§2f): the interfaces the Router
 * dispatches through. This module is library surface — it must never import the daemon's
 * host modules (secrets.ts, paths.ts, server.ts, index.ts, the audit() sink, the concrete
 * OtpGate/GhcrService classes). The daemon injects its implementations at composition
 * (src/index.ts).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** What the router needs from the upstream (hosted-MCP) client pool. */
export interface Upstream {
	forward(tool: string, args: Record<string, unknown>, token: string): Promise<CallToolResult>;
}

/**
 * The ghcr verbs the Router dispatches for ghcr_push / ghcr_push_status / ghcr_tags
 * (design #175 §2f). The daemon injects its GhcrService (host-only — it owns the
 * background job queue and config.ghcr's credentials, so it never moves into the library);
 * a host may inject any implementation. Whatever a verb returns is JSON-serialized into
 * the tool response by the Router, exactly as today.
 */
export interface GhcrVerbs {
	push(input: unknown): Promise<unknown>;
	status(input: unknown): unknown;
	tags(input: unknown): Promise<unknown>;
}
