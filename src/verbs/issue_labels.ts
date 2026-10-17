/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/issue_labels.ts
 *	@Date: 2026-10-16T17:14:34-07:00 (1792196074)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-16T17:25:33-07:00 (1792196733)
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
 *  - `swap`   → a POST of `to`, then a DELETE for every current label starting with `prefix`
 *  - `set`    → PUT    /repos/{o}/{r}/issues/{n}/labels         (explicit full replace, never empty)
 *
 * Writes run create → add → remove, so a call that fails part-way never leaves the issue
 * with fewer labels than it should have (a swap whose add is rate-limited keeps its old
 * status label). The error then names exactly what was applied and what was not.
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
/** GitHub's own per-issue label limit; also bounds the requests one call can make. */
export const MAX_LABELS = 100;
const INPUT_KEYS = new Set(["owner", "repo", "issue_number", "add", "remove", "swap", "set", "create_missing", "color"]);
const SWAP_KEYS = new Set(["prefix", "to"]);

const fail = (msg: string): never => {
	throw new Error(`issue_labels: ${msg}`);
};

function toList(v: unknown, field: string): string[] {
	if (v === undefined) return [];
	const arr = Array.isArray(v) ? v : [v];
	if (arr.length === 0) fail(`"${field}" is empty — pass at least one label name`);
	for (const x of arr) {
		if (typeof x !== "string" || !x.trim()) fail(`"${field}" must be a label name or a list of label names`);
	}
	const list = dedupe((arr as string[]).map((x) => x.trim()));
	if (list.length > MAX_LABELS) fail(`"${field}" has ${list.length} labels — at most ${MAX_LABELS} per call`);
	return list;
}

const key = (s: string): string => s.toLowerCase();

function dedupe(list: string[]): string[] {
	const seen = new Set<string>();
	return list.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}

function statusOf(err: unknown): number | undefined {
	return (err as { status?: number })?.status;
}

const fmt = (list: string[]): string => `[${list.join(", ")}]`;

type Label = { name: string };
const names = (data: unknown): string[] => (Array.isArray(data) ? (data as Label[]).map((l) => l.name) : []);

/**
 * The handler is the real contract: the MCP server does not validate against the
 * advertised inputSchema, so every key and type is checked here, before any request.
 */
function validate(input: unknown) {
	if (typeof input !== "object" || input === null || Array.isArray(input)) fail("arguments must be an object");
	const a = input as Record<string, unknown>;
	const unknown = Object.keys(a).filter((k) => !INPUT_KEYS.has(k));
	if (unknown.length) fail(`unknown argument(s): ${unknown.join(", ")} — expected ${[...INPUT_KEYS].join(", ")}`);
	if (typeof a.owner !== "string" || !a.owner.trim()) fail('"owner" must be a non-empty string');
	if (typeof a.repo !== "string" || !a.repo.trim()) fail('"repo" must be a non-empty string');
	if (typeof a.issue_number !== "number" || !Number.isInteger(a.issue_number) || a.issue_number <= 0) fail('"issue_number" must be a positive integer');
	if (a.create_missing !== undefined && typeof a.create_missing !== "boolean") fail('"create_missing" must be a boolean');
	if (a.color !== undefined && (typeof a.color !== "string" || !/^#?[0-9a-f]{6}$/i.test(a.color))) fail('"color" must be a 6-digit hex color, e.g. "ededed"');

	const add = toList(a.add, "add");
	const remove = toList(a.remove, "remove");
	const set = a.set === undefined ? undefined : toList(a.set, "set");
	let swapTo: string[] = [];
	let swapPrefix: string | undefined;
	if (a.swap !== undefined) {
		const sw = a.swap as Record<string, unknown>;
		if (typeof sw !== "object" || sw === null || Array.isArray(sw)) fail('"swap" must be an object { prefix, to }');
		const extra = Object.keys(sw).filter((k) => !SWAP_KEYS.has(k));
		if (extra.length) fail(`unknown "swap" key(s): ${extra.join(", ")} — expected prefix, to`);
		if (typeof sw.prefix !== "string" || !sw.prefix) fail('"swap.prefix" is required');
		if (sw.to === undefined) fail('"swap.to" needs at least one label');
		swapPrefix = sw.prefix as string;
		swapTo = toList(sw.to, "swap.to");
	}

	if (set !== undefined && (add.length || remove.length || swapPrefix !== undefined)) {
		fail('"set" replaces the whole label set and cannot be combined with add/remove/swap');
	}
	if (set === undefined && !add.length && !remove.length && swapPrefix === undefined) fail("nothing to do — pass add, remove, swap or set");
	const addSide = dedupe([...add, ...swapTo]);
	if (addSide.length > MAX_LABELS) fail(`${addSide.length} labels to add — at most ${MAX_LABELS} per call`);
	const removeKeys = new Set(remove.map(key));
	const clash = addSide.filter((l) => removeKeys.has(key(l)));
	if (clash.length) fail(`label(s) both added and removed: ${clash.join(", ")}`);

	return {
		owner: a.owner as string,
		repo: a.repo as string,
		issue_number: a.issue_number as number,
		remove,
		set,
		swapPrefix,
		addSide,
		createMissing: a.create_missing === true,
		color: ((a.color as string | undefined) ?? DEFAULT_COLOR).replace(/^#/, "")
	};
}

export async function issueLabels(octokit: Octokit, input: IssueLabelsInput): Promise<IssueLabelsResult> {
	const { owner, repo, issue_number, remove, set, swapPrefix, addSide, createMissing, color } = validate(input);
	const issue = `${owner}/${repo}#${issue_number}`;
	const base = { owner, repo, issue_number };
	const readLabels = async (): Promise<string[]> =>
		names((await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...base, per_page: MAX_LABELS })).data);

	// 0. The current set: needed for swap's prefix matches, for the spelling of removals and
	//    for reporting what changed. It also fails a wrong issue number (404) before anything
	//    is written or created.
	const before = await readLabels();
	const beforeKeys = new Set(before.map(key));
	const onIssue = (n: string): string | undefined => before.find((l) => key(l) === key(n));

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
	if (missing.length && !createMissing) {
		fail(`label(s) not found in ${owner}/${repo}: ${missing.join(", ")} — nothing was changed. Check the spelling (list_label), or pass create_missing: true to create them.`);
	}

	// 2. Plan the removals: only labels actually on the issue, in the issue's own spelling.
	//    swap removes every prefix match except a label this call also adds — that one stays
	//    put instead of being deleted and re-added.
	const removals: string[] = [];
	if (set === undefined) {
		for (const n of remove) {
			const hit = onIssue(n);
			if (hit) removals.push(hit);
		}
		if (swapPrefix !== undefined) {
			const keep = new Set(addSide.map(key));
			const p = key(swapPrefix);
			for (const l of before) if (key(l).startsWith(p) && !keep.has(key(l))) removals.push(l);
		}
	}
	const plannedRemovals = dedupe(removals);

	// 3. Writes. Order is chosen so a failure part-way never leaves the issue with LESS than
	//    it started with plus what was asked: create, then add (POST), and removals last.
	//    Any failure is rethrown with exactly what was applied and what was not.
	const created: string[] = [];
	let addedDone = false;
	const removed: string[] = [];
	let latest: string[] | undefined;
	const canonical = (): string[] => [...resolved, ...created];
	const canon = (n: string): string => canonical().find((c) => key(c) === key(n)) ?? n;
	try {
		for (const name of missing) {
			const res = await octokit.request("POST /repos/{owner}/{repo}/labels", { owner, repo, name, color });
			created.push((res.data as Label).name);
		}

		if (set !== undefined) {
			const res = await octokit.request("PUT /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...base, labels: set.map(canon) });
			latest = names(res.data);
			addedDone = true;
			return result(latest, before);
		}

		if (addSide.length) {
			const res = await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...base, labels: addSide.map(canon) });
			latest = names(res.data);
			addedDone = true;
		}

		for (const name of plannedRemovals) {
			try {
				const res = await octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", { ...base, name });
				latest = names(res.data);
				removed.push(name);
			} catch (err) {
				// Someone removed it since the read above: already the state asked for.
				if (statusOf(err) !== 404) throw err;
			}
		}
	} catch (err) {
		const applied: string[] = [];
		const notApplied: string[] = [];
		const part = (label: string, done: string[], all: string[]) => {
			const doneKeys = new Set(done.map(key));
			if (done.length) applied.push(`${label} ${fmt(done)}`);
			const rest = all.filter((l) => !doneKeys.has(key(l)));
			if (rest.length) notApplied.push(`${label} ${fmt(rest)}`);
		};
		part("created", created, missing);
		if (set !== undefined) part("set", addedDone ? set : [], set);
		else part("added", addedDone ? addSide.map(canon) : [], addSide.map(canon));
		part("removed", removed, plannedRemovals);
		const e = new Error(
			`issue_labels: failed part-way on ${issue}: ${(err as Error).message}. Applied: ${applied.join("; ") || "nothing"}. Not applied: ${notApplied.join("; ") || "nothing"}.`,
			{ cause: err }
		);
		(e as Error & { status?: number }).status = statusOf(err);
		throw e;
	}

	return result(latest ?? (await readLabels()), removed);

	function result(labels: string[], removedFrom: string[]): IssueLabelsResult {
		const afterKeys = new Set(labels.map(key));
		// Only what this call asked for — a label someone else added meanwhile isn't ours to report.
		const requested = new Set(toResolve.map(key));
		return {
			issue,
			labels,
			added: labels.filter((l) => requested.has(key(l)) && !beforeKeys.has(key(l))),
			removed: removedFrom.filter((l) => !afterKeys.has(key(l))),
			created
		};
	}
}

const labelList = (description: string) => ({
	description,
	oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_LABELS }]
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
		set: labelList("replace the WHOLE label set with these (at least one); cannot be combined with add/remove/swap"),
		create_missing: {
			type: "boolean",
			default: false,
			description: "create add-side labels that don't exist in the repo; without it an unknown name refuses the call and nothing changes"
		},
		color: { type: "string", pattern: "^#?[0-9a-fA-F]{6}$", description: `6-digit hex color (with or without #) for labels created via create_missing; default ${DEFAULT_COLOR}` }
	}
};
