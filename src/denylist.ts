/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/denylist.ts
 *	@Date: 2026-11-02T19:55:08-08:00 (1793678108)
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
 * Tools the broker never serves, gated or not (#146). The default-deny allowlist is what keeps
 * them out: none is written as a verb or listed in the shipped config. This list is the backup,
 * so a hand-edited `tools` entry (or a new upstream tool that does the same thing) is refused
 * when the config loads instead of being forwarded. Config can't override it.
 */

/** Exact tool names, with why each is out. */
export const DENIED_TOOLS: ReadonlyMap<string, string> = new Map([
	["create_or_update_file", "file writes go through git"],
	["push_files", "file writes go through git"],
	["delete_file", "file writes go through git"],
	["delete_repository", "deleting a repo stays a manual step in GitHub"],
	["create_repository_ruleset", "rulesets are managed by org bootstrap"],
	["custom_properties_write", "repo configuration is managed by org bootstrap"]
]);

/** Name shapes for the same classes of tool, should upstream add or rename one. */
const DENIED_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/(^|_)(create|update|delete|write)_(file|files)$|^(file|files)_(write|create|update|delete)$|^push_(file|files|commit|commits|changes)$/, "file writes go through git"],
	[/^delete_(repo|repository)(_|$)|^(repo|repository)_delete$/, "deleting a repo stays a manual step in GitHub"],
	[/^(transfer|archive|unarchive|rename)_(repo|repository)$|default_branch_(write|update|set)|^(set|update)_default_branch$/, "repo configuration is managed by org bootstrap"],
	[/ruleset_(write|create|update|delete)|(create|update|delete|manage)_.*ruleset/, "rulesets are managed by org bootstrap"],
	[/branch_protection/, "branch protection is managed by org bootstrap"],
	[/(update|edit|write)_(repo|repository)(_settings)?$|^(repo|repository)_(write|update|settings_write)$|repository_settings/, "repo configuration is managed by org bootstrap"],
	[/(actions|repo|repository|org)_(variable|secret)s?_(write|create|update|delete|set)|^(variable|secret)s?_(write|create|update|delete|set)$|^(create|update|delete|set)_.*(variable|secret)s?$/, "Actions variables and secrets are managed by org bootstrap"],
	[/workflow_permissions/, "workflow permissions are managed by org bootstrap"],
	[/^(bulk_|batch_)/, "bulk writes aren't offered; loop over the single-item tool"],
	[/(^|_)(lock|unlock)_(issue|issues|conversation|pull_request)|^(issue|issues|conversation|pull_request)_(lock|unlock)$|^lock_write$/, "locking conversations isn't offered"]
];

/** Why `name` can never be allowlisted, or undefined when it can. */
export function deniedReason(name: string): string | undefined {
	const exact = DENIED_TOOLS.get(name);
	if (exact) return exact;
	for (const [pattern, why] of DENIED_PATTERNS) if (pattern.test(name)) return why;
	return undefined;
}
