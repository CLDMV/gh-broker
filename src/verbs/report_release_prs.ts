/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/report_release_prs.ts
 *	@Date: 2026-10-03T15:00:00+00:00 (1791039600)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-03T15:00:00+00:00 (1791039600)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import type { Octokit } from "@octokit/core";
import { CallBudget, CallBudgetExhausted, RateLimited, reqOne } from "./rest-client.ts";

/**
 * Custom verb: report_release_prs — every open release PR for an owner (or one repo),
 * with whether its version's changelog file is already on the release branch.
 *
 * Built for mass updates: an agent sweeping a fleet needs to know which repos have a
 * release PR waiting and which of those still lack the curated per-version changelog
 * (`docs/changelog[s]/v<major>/vX.Y.Z.md`, the exact file the CLDMV release automation
 * injects as the release-PR body). Per-repo `list_pull_requests` over every repo would
 * be hundreds of calls; this uses ONE search call for the whole owner plus two cheap
 * calls per release PR actually found.
 *
 * A "release PR" is an open PR carrying the `release` label (applied by the v4 release
 * automation to both the `next → master` and `hotfixes → master` PRs). The version is
 * read from the `release: vX.Y.Z - …` title.
 *
 * The changelog is looked up at the PR's head commit, not the default branch — the file
 * lands on `next` before the release PR merges, so that is where it must exist.
 */

export interface ReportReleasePrsInput {
	owner: string;
	/** Repo name; omit to search every repo this owner has. */
	repo?: string;
	/** Return only release PRs that are not ready (missing changelog or unreadable version). Default false. */
	onlyMissing?: boolean;
	/** Hard ceiling on total REST calls for this invocation. Default 300, hard-capped at 1000. */
	maxApiCalls?: number;
}

export type ReleasePrStatus = "ready" | "needs-changelog" | "unknown-version";

export interface ReleasePr {
	repo: string;
	pull: number;
	url: string;
	title: string;
	/** Parsed from the `release: vX.Y.Z` title; null when the title has no version. */
	version: string | null;
	head: string;
	base: string;
	draft: boolean;
	status: ReleasePrStatus;
	/** The changelog path found, when `status` is "ready". */
	changelogPath?: string;
	/** The paths that were looked up, when `status` is "needs-changelog". */
	checkedPaths?: string[];
}

export type ReleaseTruncatedReason = "max-results" | "incomplete-search" | "max-api-calls" | "rate-limited";

export interface ReportReleasePrsResult {
	scanned: { releasePrs: number };
	summary: { ready: number; needsChangelog: number; unknownVersion: number };
	releasePrs: ReleasePr[];
	truncated?: boolean;
	truncatedReason?: ReleaseTruncatedReason;
	/** Only set when truncatedReason is "rate-limited" and GitHub sent a Retry-After. */
	retryAfterSeconds?: number;
}

const DEFAULT_MAX_API_CALLS = 300;
const HARD_MAX_API_CALLS = 1000;
const SEARCH_PAGE_SIZE = 100;

interface SearchHit {
	number: number;
	title: string;
	html_url: string;
	draft?: boolean;
	repository_url: string;
}

interface SearchResponse {
	total_count: number;
	incomplete_results: boolean;
	items: SearchHit[];
}

interface RawPull {
	head: { ref: string };
	base: { ref: string };
	draft?: boolean;
}

/** Pulls `1.2.3` (or a prerelease form) out of a `release: v1.2.3 - …` title. */
export function parseReleaseVersion(title: string): string | null {
	const m = /\brelease:\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i.exec(title);
	return m ? m[1]! : null;
}

/** The places a version's changelog can live — `changelog` and `changelogs` are both in use. */
export function changelogPaths(version: string): string[] {
	const major = version.split(".")[0]!;
	return [`docs/changelog/v${major}/v${version}.md`, `docs/changelogs/v${major}/v${version}.md`];
}

function repoFromUrl(repositoryUrl: string): { owner: string; repo: string } {
	const parts = repositoryUrl.split("/");
	return { owner: parts[parts.length - 2]!, repo: parts[parts.length - 1]! };
}

/** First of `paths` that exists at `ref`, or undefined. A 404 means "not there"; any other error propagates. */
async function findChangelog(octokit: Octokit, budget: CallBudget, owner: string, repo: string, ref: string, paths: string[]): Promise<string | undefined> {
	for (const path of paths) {
		try {
			await reqOne(octokit, budget, "GET /repos/{owner}/{repo}/contents/{path}", { owner, repo, path, ref });
			return path;
		} catch (err) {
			if (err instanceof RateLimited || err instanceof CallBudgetExhausted) throw err;
			if ((err as { status?: number }).status !== 404) throw err;
		}
	}
	return undefined;
}

export async function reportReleasePrs(octokit: Octokit, input: ReportReleasePrsInput): Promise<ReportReleasePrsResult> {
	const maxApiCalls = Math.min(input.maxApiCalls ?? DEFAULT_MAX_API_CALLS, HARD_MAX_API_CALLS);
	const budget = new CallBudget(maxApiCalls);
	const scope = input.repo ? `repo:${input.owner}/${input.repo}` : `org:${input.owner}`;

	const releasePrs: ReleasePr[] = [];
	let truncatedReason: ReleaseTruncatedReason | undefined;
	let retryAfterSeconds: number | undefined;
	let hits = 0;

	try {
		const search = await reqOne<SearchResponse>(octokit, budget, "GET /search/issues", {
			q: `${scope} is:pr is:open label:release`,
			per_page: SEARCH_PAGE_SIZE
		});
		hits = search.items.length;
		if (search.total_count > search.items.length) truncatedReason = "max-results";
		else if (search.incomplete_results) truncatedReason = "incomplete-search";

		for (const hit of search.items) {
			const { owner, repo } = repoFromUrl(hit.repository_url);
			const pull = await reqOne<RawPull>(octokit, budget, "GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: hit.number });
			const version = parseReleaseVersion(hit.title);
			const base = {
				repo: `${owner}/${repo}`,
				pull: hit.number,
				url: hit.html_url,
				title: hit.title,
				version,
				head: pull.head.ref,
				base: pull.base.ref,
				draft: pull.draft ?? hit.draft ?? false
			};
			if (version === null) {
				releasePrs.push({ ...base, status: "unknown-version" });
				continue;
			}
			const paths = changelogPaths(version);
			const found = await findChangelog(octokit, budget, owner, repo, pull.head.ref, paths);
			releasePrs.push(found ? { ...base, status: "ready", changelogPath: found } : { ...base, status: "needs-changelog", checkedPaths: paths });
		}
	} catch (err) {
		if (err instanceof RateLimited) {
			truncatedReason = "rate-limited";
			retryAfterSeconds = err.retryAfterSeconds;
		} else if (err instanceof CallBudgetExhausted) {
			truncatedReason = "max-api-calls";
		} else {
			throw err;
		}
	}

	const summary = {
		ready: releasePrs.filter((p) => p.status === "ready").length,
		needsChangelog: releasePrs.filter((p) => p.status === "needs-changelog").length,
		unknownVersion: releasePrs.filter((p) => p.status === "unknown-version").length
	};
	const listed = input.onlyMissing ? releasePrs.filter((p) => p.status !== "ready") : releasePrs;

	return {
		scanned: { releasePrs: hits },
		summary,
		releasePrs: listed,
		...(truncatedReason ? { truncated: true, truncatedReason } : {}),
		...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {})
	};
}

/** JSON Schema advertised to the agent for report_release_prs. */
export const REPORT_RELEASE_PRS_SCHEMA = {
	type: "object" as const,
	required: ["owner"],
	additionalProperties: false,
	properties: {
		owner: { type: "string", description: "repository owner (org/user login) — selects the read credential" },
		repo: { type: "string", description: "repository name; omit to search every repo this owner has" },
		onlyMissing: { type: "boolean", description: "return only release PRs that still need a changelog (or have no readable version); summary counts still cover all", default: false },
		maxApiCalls: { type: "number", description: `hard ceiling on total REST calls this invocation makes (default ${DEFAULT_MAX_API_CALLS}, hard cap ${HARD_MAX_API_CALLS})` }
	}
};
