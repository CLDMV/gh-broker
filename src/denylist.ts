/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/denylist.ts
 *	@Date: 2026-11-02T19:55:08-08:00 (1793678108)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-02T20:20:15-08:00 (1793679615)
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

const WRITE_VERBS = "create|update|delete|write|set|add|remove|edit|manage|change";

/**
 * A write to `subjects`, in either name order upstream uses: verb first (`update_repository_ruleset`,
 * `create_or_update_file`) or noun first (`repository_rulesets_write`). A tool whose name has no
 * write verb (`get_branch_protection`, `list_repository_collaborators`) never matches.
 */
const writeTo = (subjects: string, verbs = WRITE_VERBS): RegExp => new RegExp(`(^|_)(${verbs})_(.*_)?(${subjects})$|(^|_)(${subjects})_(${verbs})$`);

/** Name shapes for the same classes of tool, should upstream add or rename one. */
const DENIED_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[writeTo("files?|contents?|commits?|trees?|blobs?|refs?|git_refs?|changes", "create|update|delete|write|push"), "file writes go through git"],
	[writeTo("repo|repository", "delete"), "deleting a repo stays a manual step in GitHub"],
	// Not `create`: create_repository is a gated tool, not repo configuration.
	[writeTo("repo|repository|repo_settings|repository_settings|settings|visibility|default_branch", "update|edit|write|set|change|transfer|archive|unarchive|rename"), "repo configuration is managed by org bootstrap"],
	[writeTo("custom_property|custom_properties"), "repo configuration is managed by org bootstrap"],
	[writeTo("rulesets?"), "rulesets are managed by org bootstrap"],
	[writeTo("branch_protections?|branch_protection_rules?"), "branch protection is managed by org bootstrap"],
	[writeTo("variables?|secrets?"), "Actions variables and secrets are managed by org bootstrap"],
	[writeTo("workflow_permissions|actions_permissions"), "workflow permissions are managed by org bootstrap"],
	[writeTo("webhooks?|hooks?|deploy_keys?|collaborators?|environments?"), "repo access and configuration are managed by org bootstrap"],
	[/^(bulk|batch)_(close|lock|unlock|delete|update|write|edit|label|set|add|remove)|^close_(issues|pull_requests|prs)$|_(issues|pull_requests)_close$/, "bulk writes aren't offered; loop over the single-item tool"],
	[writeTo("issues?|conversations?|pull_requests?", "lock|unlock"), "locking conversations isn't offered"],
	[/^lock_write$/, "locking conversations isn't offered"]
];

/** Why `name` can never be allowlisted, or undefined when it can. */
export function deniedReason(name: string): string | undefined {
	const exact = DENIED_TOOLS.get(name);
	if (exact) return exact;
	for (const [pattern, why] of DENIED_PATTERNS) if (pattern.test(name)) return why;
	return undefined;
}
