/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/delete_branch.ts
 *	@Date: 2026-11-02T19:55:53-08:00 (1793678153)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-02T20:03:01-08:00 (1793678581)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import type { Octokit } from "@octokit/core";

/**
 * Custom verb: delete_branch — delete one branch on GitHub. Gated by default (#146).
 *
 * Upstream can create a branch but not delete one, so this is `DELETE /git/refs/heads/{branch}`
 * on the write PAT (Contents: write). It refuses before deleting anything when the branch is:
 *
 *  - the repo's default branch, or one of the staging-flow branches (next, hotfixes, dev) or the
 *    bot branches (badges, gh-pages), which the release machinery depends on;
 *  - the head of an open PR in the same repo, since deleting it closes that PR.
 *
 * Rulesets still apply on top: GitHub refuses a protected branch whatever this verb allows.
 * The result carries the deleted tip's sha, so the branch can be recreated from it.
 */

/** Branches the release flow depends on. Never deleted here, whatever the repo's default is. */
export const KEPT_BRANCHES: ReadonlySet<string> = new Set(["master", "main", "next", "hotfixes", "dev", "badges", "gh-pages"]);

export interface DeleteBranchInput {
	owner: string;
	repo: string;
	branch: string;
}

export interface DeleteBranchResult {
	deleted: string;
	sha: string;
	restore: string;
}

export async function deleteBranch(octokit: Octokit, input: DeleteBranchInput): Promise<DeleteBranchResult> {
	const { owner, repo } = input;
	if (typeof repo !== "string" || !repo) throw new Error("delete_branch: repo is required");
	const branch = typeof input.branch === "string" ? input.branch.replace(/^refs\/heads\//, "") : "";
	if (!branch) throw new Error("delete_branch: branch is required");
	if (KEPT_BRANCHES.has(branch)) throw new Error(`delete_branch: refusing to delete "${branch}": the release flow depends on it`);

	const meta = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
	const defaultBranch = (meta.data as { default_branch?: string }).default_branch;
	if (branch === defaultBranch) throw new Error(`delete_branch: refusing to delete "${branch}": it is ${owner}/${repo}'s default branch`);

	const open = await octokit.request("GET /repos/{owner}/{repo}/pulls", { owner, repo, state: "open", head: `${owner}:${branch}`, per_page: 10 });
	const prs = open.data as Array<{ number: number }>;
	if (prs.length > 0) {
		throw new Error(`delete_branch: refusing to delete "${branch}": it is the head of open PR ${prs.map((p) => `#${p.number}`).join(", ")}, which deleting it would close`);
	}

	const ref = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner, repo, ref: `heads/${branch}` });
	const sha = (ref.data as { object?: { sha?: string } }).object?.sha;
	// A prefix match ("heads/feat" when only "heads/feat/x" exists) answers with an array, not the ref.
	if (typeof sha !== "string") throw new Error(`delete_branch: no branch "${branch}" in ${owner}/${repo}`);

	await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", { owner, repo, ref: `heads/${branch}` });
	return { deleted: branch, sha, restore: `git push origin ${sha}:refs/heads/${branch}` };
}

export const DELETE_BRANCH_DESCRIPTION =
	"Delete one branch on GitHub. Refuses the repo's default branch, the release-flow branches (master, main, next, hotfixes, dev, badges, gh-pages), and any branch that is the head of an open PR (deleting it would close the PR). Rulesets still apply. Returns the deleted tip's sha and the git command that restores it. Runs on the write PAT (Contents: write).";

export const DELETE_BRANCH_SCHEMA = {
	type: "object" as const,
	required: ["owner", "repo", "branch"],
	additionalProperties: false,
	properties: {
		owner: { type: "string", description: "repository owner (org/user login); selects the write credential" },
		repo: { type: "string", description: "repository name" },
		branch: { type: "string", description: 'branch name, e.g. "feat/otp-gate" (a leading refs/heads/ is accepted)' }
	}
};
