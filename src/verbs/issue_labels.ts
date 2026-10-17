/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/issue_labels.ts
 *	@Date: 2026-10-16T17:14:34-07:00 (1792196074)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-16T17:17:03-07:00 (1792196223)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import type { Octokit } from "@octokit/core";

/**
 * Custom verb: issue_labels — edit the labels on one issue or PR without replacing the
 * whole set.
 *
 * Why a custom verb: the hosted MCP's only label write path is `issue_write`, whose
 * `labels` argument REPLACES every label on the issue. Changing one status label that way
 * silently drops the rest (CLDMV/gh-broker#117), and reading the set then writing the
 * merged set back loses any label someone else adds in between. GitHub's REST API has
 * per-label endpoints that touch only the labels named, so this verb drives those:
 *
 *  - `add`    → POST   /repos/{o}/{r}/issues/{n}/labels         (server-side append)
 *  - `remove` → DELETE /repos/{o}/{r}/issues/{n}/labels/{name}  (one call per label)
 *  - `swap`   → the DELETEs for every current label starting with `prefix`, then a POST of `to`
 *  - `set`    → PUT    /repos/{o}/{r}/issues/{n}/labels         (explicit full replace)
 *
 * Issues and PRs share these endpoints, so a PR number works the same way.
 *
 * Label names to ADD (via `add`, `swap.to` or `set`) must already exist in the repo —
 * a typo would otherwise create a stray label silently. `create_missing: true` creates
 * them instead. Every add-side name is checked before any write, so a refused call
 * changes nothing.
 *
 * GitHub label names are case-insensitive; all matching here (existence, swap prefix,
 * add/remove overlap) is too, and the repo's own spelling is what gets written.
 */

export interface IssueLabelsSwap {
	/** Every current label starting with this (e.g. "status: ") is removed. */
	prefix: string;
	/** Then these are added. One label or several. */
	to: string | string[];
}

export interface IssueLabelsInput {
	owner: string;
	repo: string;
	/** Issue or pull-request number. */
	issue_number: number;
	add?: string | string[];
	remove?: string | string[];
	swap?: IssueLabelsSwap;
	/** Replace the whole set. Cannot be combined with add/remove/swap. */
	set?: string | string[];
	/** Create add-side labels that don't exist in the repo instead of refusing. */
	create_missing?: boolean;
	/** Hex color (no #) for labels created via create_missing. */
	color?: string;
}

export interface IssueLabelsResult {
	issue: string;
	/** The issue's label set after the call. */
	labels: string[];
	added: string[];
	removed: string[];
	created: string[];
}

const DEFAULT_COLOR = "ededed";

function toList(v: string | string[] | undefined, field: string): string[] {
	if (v === undefined) return [];
	const arr = Array.isArray(v) ? v : [v];
	for (const x of arr) {
		if (typeof x !== "string" || !x.trim()) throw new Error(`issue_labels: "${field}" must be a label name or a list of label names`);
	}
	return dedupe(arr.map((x) => x.trim()));
}

const key = (s: string): string => s.toLowerCase();

function dedupe(list: string[]): string[] {
	const seen = new Set<string>();
	return list.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}

function statusOf(err: unknown): number | undefined {
	return (err as { status?: number })?.status;
}

type Label = { name: string };
const names = (data: unknown): string[] => (Array.isArray(data) ? (data as Label[]).map((l) => l.name) : []);

export async function issueLabels(octokit: Octokit, input: IssueLabelsInput): Promise<IssueLabelsResult> {
	const { owner, repo } = input;
	const issue_number = Number(input.issue_number);
	if (!owner || !repo) throw new Error("issue_labels: owner and repo are required");
	if (!Number.isInteger(issue_number) || issue_number <= 0) throw new Error("issue_labels: issue_number must be a positive integer");

	const add = toList(input.add, "add");
	const remove = toList(input.remove, "remove");
	const set = input.set === undefined ? undefined : toList(input.set, "set");
	let swapTo: string[] = [];
	let swapPrefix: string | undefined;
	if (input.swap !== undefined) {
		if (typeof input.swap?.prefix !== "string" || !input.swap.prefix) throw new Error('issue_labels: "swap.prefix" is required');
		swapPrefix = input.swap.prefix;
		swapTo = toList(input.swap.to, "swap.to");
		if (swapTo.length === 0) throw new Error('issue_labels: "swap.to" needs at least one label');
	}

	if (set !== undefined && (add.length || remove.length || swapPrefix !== undefined)) {
		throw new Error('issue_labels: "set" replaces the whole label set and cannot be combined with add/remove/swap');
	}
	if (set === undefined && !add.length && !remove.length && swapPrefix === undefined) {
		throw new Error("issue_labels: nothing to do — pass add, remove, swap or set");
	}
	const addSide = dedupe([...add, ...swapTo]);
	const removeKeys = new Set(remove.map(key));
	const clash = addSide.filter((l) => removeKeys.has(key(l)));
	if (clash.length) throw new Error(`issue_labels: label(s) both added and removed: ${clash.join(", ")}`);

	const base = { owner, repo, issue_number };
	const readLabels = async (): Promise<string[]> =>
		names((await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...base, per_page: 100 })).data);

	// 0. The current set: needed for swap's prefix matches and for reporting what changed.
	//    It also fails a wrong issue number (404) before anything is written or created.
	const before = await readLabels();
	const beforeKeys = new Set(before.map(key));

	// 1. Resolve every add-side label against the repo before writing anything.
	const toResolve = set ?? addSide;
	const resolved: string[] = [];
	const missing: string[] = [];
	for (const name of toResolve) {
		try {
			const res = await octokit.request("GET /repos/{owner}/{repo}/labels/{name}", { owner, repo, name });
			resolved.push((res.data as Label).name);
		} catch (err) {
			if (statusOf(err) !== 404) throw err;
			missing.push(name);
		}
	}
	const created: string[] = [];
	if (missing.length) {
		if (!input.create_missing) {
			throw new Error(
				`issue_labels: label(s) not found in ${owner}/${repo}: ${missing.join(", ")} — nothing was changed. Check the spelling (list_label), or pass create_missing: true to create them.`
			);
		}
		const color = (input.color ?? DEFAULT_COLOR).replace(/^#/, "");
		for (const name of missing) {
			const res = await octokit.request("POST /repos/{owner}/{repo}/labels", { owner, repo, name, color });
			created.push((res.data as Label).name);
		}
	}
	const canonical = [...resolved, ...created];
	const canon = (n: string): string => canonical.find((c) => key(c) === key(n)) ?? n;
	const result = (labels: string[], removed: string[]): IssueLabelsResult => {
		const afterKeys = new Set(labels.map(key));
		// Only what this call asked for — a label someone else added meanwhile isn't ours to report.
		const requested = new Set(toResolve.map(key));
		return {
			issue: `${owner}/${repo}#${issue_number}`,
			labels,
			added: labels.filter((l) => requested.has(key(l)) && !beforeKeys.has(key(l))),
			removed: removed.filter((l) => !afterKeys.has(key(l))),
			created
		};
	};

	// 2. `set`: one PUT, done.
	if (set !== undefined) {
		const res = await octokit.request("PUT /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...base, labels: set.map(canon) });
		return result(names(res.data), before);
	}

	// 3. Removals. swap removes every current prefix match, except a label already in
	//    `to` — that one stays put rather than being removed and re-added.
	const removals = [...remove];
	if (swapPrefix !== undefined) {
		const keep = new Set(swapTo.map(key));
		const p = key(swapPrefix);
		for (const l of before) if (key(l).startsWith(p) && !keep.has(key(l))) removals.push(l);
	}
	let latest: string[] | undefined;
	const removed: string[] = [];
	for (const name of dedupe(removals)) {
		try {
			const res = await octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", { ...base, name });
			latest = names(res.data);
			removed.push(name);
		} catch (err) {
			// The label isn't on the issue: a no-op, not an error.
			if (statusOf(err) !== 404) throw err;
		}
	}

	// 4. Additions: POST appends server-side, so a label someone else adds meanwhile is
	//    kept; ones already present are a no-op.
	if (addSide.length) {
		const res = await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...base, labels: addSide.map(canon) });
		latest = names(res.data);
	}

	return result(latest ?? (await readLabels()), removed);
}

const labelList = (description: string) => ({
	description,
	oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }]
});

/** JSON Schema advertised to the agent for issue_labels. */
export const ISSUE_LABELS_SCHEMA = {
	type: "object" as const,
	required: ["owner", "repo", "issue_number"],
	additionalProperties: false,
	properties: {
		owner: { type: "string", description: "repository owner (org/user login) — selects the write credential" },
		repo: { type: "string", description: "repository name" },
		issue_number: { type: "number", description: "issue or pull-request number" },
		add: labelList("label(s) to add; ones already on the issue are a no-op"),
		remove: labelList("label(s) to remove; ones the issue doesn't have are a no-op"),
		swap: {
			type: "object",
			additionalProperties: false,
			required: ["prefix", "to"],
			description: 'remove every current label starting with prefix, then add to — e.g. { "prefix": "status: ", "to": "status: verified" }',
			properties: {
				prefix: { type: "string", description: 'label-name prefix, e.g. "status: "' },
				to: labelList("label(s) to add after the prefix matches are removed")
			}
		},
		set: labelList("replace the WHOLE label set with these; cannot be combined with add/remove/swap"),
		create_missing: {
			type: "boolean",
			default: false,
			description: "create add-side labels that don't exist in the repo; without it an unknown name refuses the call and nothing changes"
		},
		color: { type: "string", description: `hex color (no #) for labels created via create_missing; default ${DEFAULT_COLOR}` }
	}
};
