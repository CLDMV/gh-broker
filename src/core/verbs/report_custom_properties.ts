/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/core/verbs/report_custom_properties.ts
 *	@Date: 2026-11-22T02:51:38+00:00 (1795315898)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-22T02:51:38+00:00 (1795315898)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import type { Octokit } from "@octokit/core";
import { CallBudget, CallBudgetExhausted, RateLimited, paginate, reqOne } from "./rest-client.ts";

/**
 * Custom verb: report_custom_properties — the custom property values set on one repo, or on
 * every repo in an org.
 *
 * With `repo`, one call to `GET /repos/{owner}/{repo}/properties/values`. Without it, the org
 * listing `GET /orgs/{org}/properties/values`, paginated, with `repositoryQuery` passed through
 * as `repository_query` (GitHub's repo-search syntax). `property` keeps only repos that have that
 * property set and reports just that one; `value` additionally requires that value (for a
 * multi-select property, one of its values). The filters run here, on what GitHub returned.
 *
 * Needs "Custom properties: read" on the read PAT: the repository permission for the per-repo
 * call, the organization permission for the org listing. A 403 that isn't a rate limit says so.
 * Fan-out safety mirrors the other report verbs (see rest-client.ts).
 */

export type PropertyValue = string | string[] | null;

export interface ReportCustomPropertiesInput {
	owner: string;
	/** One repo; omit to list every repo in the org. */
	repo?: string;
	/** Only repos where this property is set, and only this property in each. */
	property?: string;
	/** With `property`: only repos where it has this value (or, multi-select, includes it). */
	value?: string;
	/** Org listing only: GitHub repo-search query, passed through as `repository_query`. */
	repositoryQuery?: string;
	maxRepos?: number;
	maxApiCalls?: number;
}

export interface RepoProperties {
	repo: string;
	properties: Record<string, PropertyValue>;
}

export type CustomPropertiesTruncatedReason = "max-repos" | "max-api-calls" | "rate-limited";

export interface ReportCustomPropertiesResult {
	owner: string;
	repo?: string;
	repos: RepoProperties[];
	count: number;
	truncated?: boolean;
	truncatedReason?: CustomPropertiesTruncatedReason;
	retryAfterSeconds?: number;
}

interface RawValue {
	property_name: string;
	value: PropertyValue;
}

interface RawOrgEntry {
	repository_name: string;
	properties: RawValue[];
}

const DEFAULT_MAX_REPOS = 1000;
const HARD_MAX_REPOS = 5000;
const DEFAULT_MAX_API_CALLS = 30;
const HARD_MAX_API_CALLS = 100;

export const REPORT_CUSTOM_PROPERTIES_SCHEMA = {
	type: "object" as const,
	required: ["owner"],
	additionalProperties: false,
	properties: {
		owner: { type: "string", description: "repository owner (org login) — selects the read credential" },
		repo: { type: "string", description: "one repository; omit to list every repo in the org" },
		property: { type: "string", description: "only repos where this property is set, reporting just this property" },
		value: { type: "string", description: "with property: only repos where it has this value (for a multi-select property, one of its values)" },
		repositoryQuery: { type: "string", description: "org listing only: a GitHub repository search query, passed through as repository_query (e.g. \"archived:false\")" },
		maxRepos: { type: "number", description: `org listing: stop after this many repos (default ${DEFAULT_MAX_REPOS}, hard cap ${HARD_MAX_REPOS})` },
		maxApiCalls: { type: "number", description: `hard ceiling on total REST calls (default ${DEFAULT_MAX_API_CALLS}, hard cap ${HARD_MAX_API_CALLS})` }
	}
};

const toRecord = (values: RawValue[]): Record<string, PropertyValue> => Object.fromEntries(values.map((v) => [v.property_name, v.value]));

/** Applies `property` / `value`: undefined means the repo is filtered out. */
export function filterProperties(properties: Record<string, PropertyValue>, property?: string, value?: string): Record<string, PropertyValue> | undefined {
	if (property === undefined) return properties;
	const v = properties[property];
	if (v === undefined || v === null) return undefined;
	if (value !== undefined && !(Array.isArray(v) ? v.includes(value) : v === value)) return undefined;
	return { [property]: v };
}

function permissionHint(err: unknown, scope: "repository" | "organization"): never {
	const status = (err as { status?: number }).status;
	if (status === 403) throw new Error(`GitHub refused the custom properties read (403). The read PAT needs the ${scope} permission "Custom properties: read".`);
	throw err;
}

export async function reportCustomProperties(octokit: Octokit, input: ReportCustomPropertiesInput): Promise<ReportCustomPropertiesResult> {
	const { owner, repo, property, value } = input;
	if (value !== undefined && property === undefined) throw new Error("value needs property: name the property to match it against");
	const budget = new CallBudget(Math.min(input.maxApiCalls ?? DEFAULT_MAX_API_CALLS, HARD_MAX_API_CALLS));

	if (repo !== undefined) {
		if (input.repositoryQuery !== undefined) throw new Error("repositoryQuery applies to the org listing only; drop it or drop repo");
		let raw: RawValue[];
		try {
			raw = await reqOne<RawValue[]>(octokit, budget, "GET /repos/{owner}/{repo}/properties/values", { owner, repo });
		} catch (err) {
			if (err instanceof RateLimited) return { owner, repo, repos: [], count: 0, truncated: true, truncatedReason: "rate-limited", ...(err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : {}) };
			if (err instanceof CallBudgetExhausted) return { owner, repo, repos: [], count: 0, truncated: true, truncatedReason: "max-api-calls" };
			permissionHint(err, "repository");
		}
		const props = filterProperties(toRecord(raw), property, value);
		const repos = props ? [{ repo, properties: props }] : [];
		return { owner, repo, repos, count: repos.length };
	}

	const maxRepos = Math.min(input.maxRepos ?? DEFAULT_MAX_REPOS, HARD_MAX_REPOS);
	const result: ReportCustomPropertiesResult = { owner, repos: [], count: 0 };
	let raw: RawOrgEntry[] = [];
	try {
		// One more than the cap, so hitting it exactly isn't reported as truncation.
		raw = await paginate<RawOrgEntry>(octokit, budget, "GET /orgs/{org}/properties/values", { org: owner, ...(input.repositoryQuery !== undefined ? { repository_query: input.repositoryQuery } : {}) }, maxRepos + 1);
		if (raw.length > maxRepos) {
			raw = raw.slice(0, maxRepos);
			result.truncated = true;
			result.truncatedReason = "max-repos";
		}
	} catch (err) {
		if (err instanceof RateLimited) {
			result.truncated = true;
			result.truncatedReason = "rate-limited";
			if (err.retryAfterSeconds !== undefined) result.retryAfterSeconds = err.retryAfterSeconds;
		} else if (err instanceof CallBudgetExhausted) {
			result.truncated = true;
			result.truncatedReason = "max-api-calls";
		} else if ((err as { status?: number }).status === 404) {
			throw new Error(`${owner} has no org custom properties to list (custom properties are org-only); pass repo to read one repository`);
		} else {
			permissionHint(err, "organization");
		}
	}
	for (const entry of raw) {
		const props = filterProperties(toRecord(entry.properties ?? []), property, value);
		if (props) result.repos.push({ repo: entry.repository_name, properties: props });
	}
	result.count = result.repos.length;
	return result;
}
