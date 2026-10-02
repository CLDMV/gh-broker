/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/link_issue.ts
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

import type { Octokit } from "@octokit/core";

/**
 * Custom verb: link_issue — create an EXPLICIT PR→issue closing reference via the
 * `addClosingIssueReference` GraphQL mutation.
 *
 * Why a custom verb and why an App token:
 *  - The hosted GitHub MCP has no tool for PR→issue closing links (verified), so
 *    it can't be proxied — it's a direct GitHub API call.
 *  - `addClosingIssueReference` is NOT in the fine-grained-PAT GraphQL schema
 *    (GitHub returns "Field doesn't exist", distinct from a permission error). It
 *    is available to GitHub **App** tokens — exactly what CLDMV's own
 *    `sync-closing-issues` action uses. So this runs on an App-authed Octokit.
 *  - We deliberately do NOT depend on commit-message keywords for linkage.
 *
 * Uses Octokit (`octokit.graphql`) — GitHub's official SDK — not a hand-rolled fetch.
 */

export interface LinkIssueInput {
	owner: string;
	repo: string;
	/** pull request number */
	pull: number;
	/** issue number to link as a closing reference */
	issue: number;
}

const RESOLVE_IDS = `
	query($owner: String!, $repo: String!, $pr: Int!, $issue: Int!) {
		repository(owner: $owner, name: $repo) {
			pullRequest(number: $pr) { id }
			issue(number: $issue) { id }
		}
	}`;

const ADD_CLOSING_REF = `
	mutation($prId: ID!, $issueId: ID!) {
		addClosingIssueReference(input: { pullRequestId: $prId, issueId: $issueId }) {
			pullRequest { id }
		}
	}`;

/** Resolve node IDs, then create the closing reference. Returns the linked node IDs. */
export async function linkIssue(octokit: Octokit, input: LinkIssueInput): Promise<{ pullRequestId: string; issueId: string }> {
	const ids = await octokit.graphql<{
		repository: { pullRequest: { id: string } | null; issue: { id: string } | null };
	}>(RESOLVE_IDS, { owner: input.owner, repo: input.repo, pr: input.pull, issue: input.issue });

	const pullRequestId = ids.repository.pullRequest?.id;
	const issueId = ids.repository.issue?.id;
	if (!pullRequestId) throw new Error(`link_issue: PR #${input.pull} not found in ${input.owner}/${input.repo}`);
	if (!issueId) throw new Error(`link_issue: issue #${input.issue} not found in ${input.owner}/${input.repo}`);

	await octokit.graphql(ADD_CLOSING_REF, { prId: pullRequestId, issueId });
	return { pullRequestId, issueId };
}

/** JSON Schema advertised to the agent for this custom verb. */
export const LINK_ISSUE_SCHEMA = {
	type: "object" as const,
	required: ["owner", "repo", "pull", "issue"],
	additionalProperties: false,
	properties: {
		owner: { type: "string", description: "repository owner (org/user login)" },
		repo: { type: "string", description: "repository name" },
		pull: { type: "integer", description: "pull request number" },
		issue: { type: "integer", description: "issue number to close when the PR merges to the default branch" }
	}
};
