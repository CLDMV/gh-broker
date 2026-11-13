/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/audit.ts
 *	@Date: 2026-07-07T00:24:51-07:00 (1783409091)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-02T20:12:05-08:00 (1793679125)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Structured audit log. One JSON line per decision/call to stdout (journald
 * captures it). NEVER include token values or OTP codes — only tool, owner, mode, repo, result.
 */

import type { AuditEntry } from "./types.ts";

// The entry shape is shared vocabulary (src/types.ts, next to SecurityEvent); this is its sink.
export type { AuditEntry };

export function audit(entry: AuditEntry): void {
	// eslint-disable-next-line no-console -- journald is the sink
	console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}
