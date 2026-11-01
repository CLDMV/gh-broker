/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/repo-tier.ts
 *	@Date: 2026-10-04T15:40:09-07:00 (1791153609)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-04T16:41:24-07:00 (1791157284)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Classifies a repo into the CLDMV flow tiers the maintenance skills care about.
 *
 *  - `v4`        — carries the v4 release workflow and is a normal next → master staging-flow repo.
 *  - `dev-trunk` — a v4 repo whose real code lives on a persistent `dev` branch while the default
 *                  branch / `next` hold only the scaffold.
 *  - `non-v4`    — no v4 release workflow on the default branch (even if `next`/`hotfixes` exist).
 *
 * Detection is structural, from three cheap reads, so a skill doesn't have to walk branches and
 * workflow folders itself. It is a signal, not a verdict: a stale `dev` branch on a repo whose
 * `next` happens to equal `master` right after a release looks like a dev-trunk repo, so the
 * raw `signals` are returned for the caller to cross-check.
 */

import type { Octokit } from "@octokit/core";
import { CallBudget, CallBudgetExhausted, RateLimited, reqOne } from "./rest-client.ts";

export type RepoTierName = "v4" | "dev-trunk" | "non-v4";

export interface RepoTier {
	tier: RepoTierName;
	signals: {
		/** `.github/workflows/next-release.yml` exists on the default branch. */
		v4Workflow: boolean;
		defaultBranch?: string;
		/** `next` branch exists. */
		next?: boolean;
		/** `dev` branch exists. */
		dev?: boolean;
		/** `next` is at the same commit as the default branch (nothing queued; scaffold-only when dev exists). */
		nextEqualsDefault?: boolean;
		/** `dev` is at a different commit than the default branch. */
		devDiffersFromDefault?: boolean;
	};
}

async function getOrUndefined<T>(octokit: Octokit, budget: CallBudget, route: string, params: Record<string, unknown>): Promise<T | undefined> {
	try {
		return await reqOne<T>(octokit, budget, route, params);
	} catch (err) {
		if (err instanceof RateLimited || err instanceof CallBudgetExhausted) throw err;
		if ((err as { status?: number }).status === 404) return undefined;
		throw err;
	}
}

/** `knownDefaultBranch` lets a caller that already read the repo skip the extra GET. */
export async function classifyRepo(octokit: Octokit, budget: CallBudget, owner: string, repo: string, knownDefaultBranch?: string): Promise<RepoTier> {
	const defaultBranch =
		knownDefaultBranch ?? (await getOrUndefined<{ default_branch?: string }>(octokit, budget, "GET /repos/{owner}/{repo}", { owner, repo }))?.default_branch;
	const workflow = await getOrUndefined<unknown>(octokit, budget, "GET /repos/{owner}/{repo}/contents/{path}", {
		owner,
		repo,
		path: ".github/workflows/next-release.yml",
		...(defaultBranch ? { ref: defaultBranch } : {})
	});
	const v4Workflow = workflow !== undefined;
	if (!v4Workflow) return { tier: "non-v4", signals: { v4Workflow, ...(defaultBranch ? { defaultBranch } : {}) } };

	const sha = async (branch: string): Promise<string | undefined> => {
		const b = await getOrUndefined<{ commit?: { sha?: string } }>(octokit, budget, "GET /repos/{owner}/{repo}/branches/{branch}", { owner, repo, branch });
		return b?.commit?.sha;
	};
	const [defaultSha, nextSha, devSha] = await Promise.all([defaultBranch ? sha(defaultBranch) : undefined, sha("next"), sha("dev")]);
	const signals: RepoTier["signals"] = {
		v4Workflow,
		...(defaultBranch ? { defaultBranch } : {}),
		next: nextSha !== undefined,
		dev: devSha !== undefined,
		...(nextSha && defaultSha ? { nextEqualsDefault: nextSha === defaultSha } : {}),
		...(devSha && defaultSha ? { devDiffersFromDefault: devSha !== defaultSha } : {})
	};
	const scaffoldOnly = nextSha === undefined || nextSha === defaultSha;
	const tier: RepoTierName = devSha !== undefined && signals.devDiffersFromDefault && scaffoldOnly ? "dev-trunk" : "v4";
	return { tier, signals };
}
