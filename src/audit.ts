/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/audit.ts
 *	@Date: 2026-07-07T00:24:51-07:00 (1783409091)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T11:30:58-07:00 (1790965858)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Structured audit log. One JSON line per decision/call to stdout (journald
 * captures it). NEVER include token values — only tool, owner, mode, repo, result.
 */

export interface AuditEntry {
	tool: string;
	owner?: string;
	mode?: "read" | "write";
	repo?: string;
	decision: "forward" | "custom" | "augment" | "deny" | "error";
	ok?: boolean;
	detail?: string;
}

export function audit(entry: AuditEntry): void {
	// eslint-disable-next-line no-console -- journald is the sink
	console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}
