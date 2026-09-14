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
