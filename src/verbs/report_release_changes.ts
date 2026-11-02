/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/report_release_changes.ts
 *	@Date: 2026-11-01T14:02:26-08:00 (1793570546)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T14:02:26-08:00 (1793570546)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import type { Octokit } from "@octokit/core";
import { CallBudget, CallBudgetExhausted, RateLimited, paginate, reqOne } from "./rest-client.ts";
import { commitType, mentionedPrs, releaseCommitPrs } from "./release-analysis.ts";
import { changelogPaths, parseReleaseVersion } from "./report_release_prs.ts";

/**
 * Custom verb: report_release_changes — the source material for one release's changelog.
 *
 * `report_release_prs` decides whether a changelog is needed or stale; this supplies what goes in it.
 * For one release PR it works out which PRs actually ship (from the release PR's commits, first line
 * only, with the same extraction `analyze` uses), drops the ones an earlier release already carried
 * and the ones reverted inside the range, fetches each remaining PR at the requested detail level,
 * groups them by changelog section, and precomputes the release's net facts (package.json deltas,
 * direct-dependency changes, file totals). Interim hotfix releases on the base branch that are not
 * on the release's head branch are listed so they don't get missed.
 *
 * Scoped by net change, not by `git log base..head`: when `next` is not reset after a squash release
 * it keeps the pre-squash commits, and those already-shipped PRs show up in the release PR's commit
 * list again. They are recognised by appearing in an earlier release PR's commits or in the previous
 * version's changelog.
 */

export type ChangeDetail = "titles" | "summaries" | "files" | "diff";

export interface ReportReleaseChangesInput {
	owner: string;
	repo: string;
	/** The release PR number. */
	pull: number;
	/** How much per PR. Default "summaries". */
	detail?: ChangeDetail;
	/** Only these PRs get `detail`; the rest get "titles". */
	prs?: number[];
	/** Also return a changelog skeleton in markdown. Default false. */
	skeleton?: boolean;
	/** Per-PR body cap in characters. Default 3000. */
	maxBodyChars?: number;
	/** Per-PR file-list cap. Default 50, hard cap 300. */
	maxFiles?: number;
	/** Per-file patch cap in characters (detail "diff"). Default 3000. */
	maxPatchChars?: number;
	/** Total patch characters across the whole report (detail "diff"). Default 60000. */
	maxDiffChars?: number;
	/** Hard ceiling on total REST calls for this invocation. Default 300, hard-capped at 1000. */
	maxApiCalls?: number;
}

export type ChangeSection = "breaking" | "features" | "fixes" | "security" | "ciTooling" | "documentation" | "dependencies";

export interface ChangeFile {
	path: string;
	status: string;
	additions: number;
	deletions: number;
	patch?: string;
	patchTruncated?: boolean;
	/** Why the patch was left out: a generated path, or the report's total diff cap was reached. */
	patchSkipped?: "generated" | "max-diff-chars";
}

export interface ReleaseChangePr {
	number: number;
	url: string;
	title: string;
	/** Conventional-commit type of the title, "" when it isn't conventional. */
	type: string;
	scope?: string;
	/** False when the call budget ran out before this PR was read; only the commit's title is known. */
	fetched: boolean;
	labels?: string[];
	author?: string;
	mergedAt?: string | null;
	/** Same-repo issues the body closes with a closing keyword (`Closes #12`). */
	closes?: number[];
	additions?: number;
	deletions?: number;
	changedFiles?: number;
	/** The current version's changelog already mentions this PR. */
	documented?: boolean;
	section?: ChangeSection;
	breaking?: string[];
	body?: string;
	bodyTruncated?: boolean;
	files?: ChangeFile[];
	filesTruncated?: boolean;
}

export interface ExcludedPr {
	number: number;
	title: string;
	reason: "earlier-release" | "earlier-changelog" | "reverted" | "revert";
	/** For "reverted": the PR that reverted it. For "revert": the PR it reverted. */
	pair?: number;
}

export interface HotfixRelease {
	version: string | null;
	pull: number;
	title: string;
	url: string;
	sha: string;
}

export interface PreviousRelease {
	version: string | null;
	tag: string | null;
	pull?: number;
	sha: string;
	/** "hotfix" when the release PR came from a hotfixes/hotfix branch. */
	kind: "full" | "hotfix";
}

export interface DependencyChange {
	name: string;
	scope: "runtime" | "dev" | "optional" | "peer";
	change: "added" | "removed" | "changed";
	from?: string;
	to?: string;
	/** Locked versions from package-lock.json, when it could be read on that side. */
	lockedFrom?: string;
	lockedTo?: string;
}

export interface NetFacts {
	packageJson?: {
		version?: { from?: string; to?: string };
		engines?: { from?: unknown; to?: unknown };
		exports?: { added: string[]; removed: string[] };
		changed: string[];
	};
	dependencies?: DependencyChange[];
	files?: {
		changed: number;
		additions: number;
		deletions: number;
		/** Same totals with lockfiles, `dist/` and `types/` left out (over the files listed). */
		excludingGenerated: { changed: number; additions: number; deletions: number };
		/** False when the release has more files than were listed. */
		complete: boolean;
	};
	breakingHints: string[];
}

export type ReleaseChangesTruncatedReason = "max-api-calls" | "rate-limited";

export interface ReportReleaseChangesResult {
	repo: string;
	pull: number;
	url?: string;
	title?: string;
	version?: string | null;
	head?: string;
	base?: string;
	previousRelease?: PreviousRelease | null;
	changelog?: { path: string | null; checkedPaths: string[] };
	prs: ReleaseChangePr[];
	groups: Record<ChangeSection | "ungrouped", number[]>;
	excluded: ExcludedPr[];
	hotfixes: HotfixRelease[];
	/** PR numbers asked for in `prs` that are not part of this release. */
	notInRelease?: number[];
	net?: NetFacts;
	skeleton?: string;
	truncated?: boolean;
	truncatedReason?: ReleaseChangesTruncatedReason;
	retryAfterSeconds?: number;
}

const DEFAULT_MAX_API_CALLS = 300;
const HARD_MAX_API_CALLS = 1000;
const DEFAULT_MAX_BODY_CHARS = 3000;
const DEFAULT_MAX_FILES = 50;
const HARD_MAX_FILES = 300;
const DEFAULT_MAX_PATCH_CHARS = 3000;
const DEFAULT_MAX_DIFF_CHARS = 60000;
/** Release commits on the base branch examined for earlier releases and hotfixes. */
const MAX_EARLIER_RELEASES = 5;
const RELEASE_FILES_LIMIT = 300;
const DETAIL_RANK: Record<ChangeDetail, number> = { titles: 0, summaries: 1, files: 2, diff: 3 };
const SECTIONS: ChangeSection[] = ["breaking", "features", "fixes", "security", "ciTooling", "documentation", "dependencies"];

/** `feat(api)!: x` -> { type: "feat", scope: "api", bang: true }. */
export function parseConventional(title: string): { type: string; scope?: string; bang: boolean } {
	const m = /^([a-z]+)(?:\(([^)]*)\))?(!)?:/i.exec(title.trim());
	if (!m) return { type: "", bang: false };
	return { type: m[1]!.toLowerCase(), ...(m[2] ? { scope: m[2].toLowerCase() } : {}), bang: m[3] === "!" };
}

/**
 * The PR a revert undoes, from the revert's title: GitHub's `Revert "feat: x (#12)"` (squash) or a
 * `Merge pull request #15 from o/revert-12-branch` merge commit. Undefined when it isn't a revert.
 */
export function revertedPr(title: string): number | undefined {
	const quoted = /^Revert\s+"(.*)"\s*$/i.exec(title.trim());
	if (quoted) {
		const inner = /\(#(\d+)\)\s*$/.exec(quoted[1]!);
		return inner ? Number(inner[1]) : undefined;
	}
	const branch = /^Merge pull request #\d+ from \S+\/revert-(\d+)-/.exec(title);
	return branch ? Number(branch[1]) : undefined;
}

/** Same-repo issue numbers a PR body closes with a GitHub closing keyword. */
export function closingIssues(body: string, owner: string, repo: string): number[] {
	const out = new Set<number>();
	const self = `${owner}/${repo}`.toLowerCase();
	for (const m of body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gi)) {
		if (m[1] === undefined || m[1].toLowerCase() === self) out.add(Number(m[2]));
	}
	return [...out];
}

/** Breaking-change hints for one PR: `!` in the type, `BREAKING CHANGE` in the body, a `semver: major` label. */
export function breakingHints(title: string, body: string, labels: string[]): string[] {
	const hints: string[] = [];
	if (parseConventional(title).bang) hints.push("`!` in the type");
	if (/BREAKING[ -]CHANGES?\b/.test(body)) hints.push("BREAKING CHANGE in the body");
	if (labels.some((l) => l.toLowerCase() === "semver: major")) hints.push("semver: major label");
	return hints;
}

function sectionsFromLabels(labels: string[]): Set<ChangeSection> {
	const out = new Set<ChangeSection>();
	for (const raw of labels) {
		const l = raw.toLowerCase();
		if (/security/.test(l)) out.add("security");
		else if (l === "type: feature" || l === "type: feature request" || l === "type: enhancement") out.add("features");
		else if (l === "type: bug") out.add("fixes");
		else if (l === "type: dependencies" || l === "dependencies") out.add("dependencies");
		else if (l === "type: ci" || l === "type: config") out.add("ciTooling");
		else if (l === "type: documentation" || l === "documentation") out.add("documentation");
	}
	return out;
}

function sectionFromType(type: string, scope: string | undefined, author: string): ChangeSection | undefined {
	if (type === "security" || scope === "security") return "security";
	if (type === "deps" || scope === "deps" || scope === "deps-dev" || author.toLowerCase().startsWith("dependabot")) return "dependencies";
	if (type === "feat") return "features";
	if (type === "fix") return "fixes";
	if (type === "ci" || type === "chore" || type === "build" || type === "test" || type === "style") return "ciTooling";
	if (type === "docs") return "documentation";
	return undefined;
}

/**
 * The changelog section for one PR, from its title's type and its labels. A breaking hint wins, then
 * security. Otherwise the type and labels must agree on one section; when they disagree, or neither
 * says anything (`refactor`, `perf`, a non-conventional title), the PR is left ungrouped.
 */
export function sectionFor(pr: { title: string; labels: string[]; author: string; breaking: string[] }): ChangeSection | undefined {
	if (pr.breaking.length > 0) return "breaking";
	const { type, scope } = parseConventional(pr.title);
	const fromType = sectionFromType(type, scope, pr.author);
	const fromLabels = sectionsFromLabels(pr.labels);
	if (fromType === "security" || fromLabels.has("security")) return "security";
	const all = new Set(fromLabels);
	if (fromType) all.add(fromType);
	return all.size === 1 ? [...all][0] : undefined;
}

/** Lockfiles and build output — left out of patches and of the "excluding generated" totals. */
export function isGenerated(path: string): boolean {
	return /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path) || /^(dist|types)\//.test(path);
}

/** The subpaths an `exports` field publishes: "." for a string or a pure conditions object. */
export function exportKeys(exportsField: unknown): string[] {
	if (exportsField === undefined || exportsField === null) return [];
	if (typeof exportsField !== "object" || Array.isArray(exportsField)) return ["."];
	const keys = Object.keys(exportsField);
	return keys.some((k) => k.startsWith(".")) ? keys.filter((k) => k.startsWith(".")) : ["."];
}

type Pkg = Record<string, unknown>;
type Lock = { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };

const DEP_SCOPES: Array<[DependencyChange["scope"], string]> = [
	["runtime", "dependencies"],
	["dev", "devDependencies"],
	["optional", "optionalDependencies"],
	["peer", "peerDependencies"]
];

function lockedVersion(lock: Lock | undefined, name: string): string | undefined {
	return lock?.packages?.[`node_modules/${name}`]?.version ?? lock?.dependencies?.[name]?.version;
}

/** Direct-dependency changes between two package.json files, with locked versions when the lockfiles are there. */
export function dependencyChanges(from: Pkg, to: Pkg, lockFrom?: Lock, lockTo?: Lock): DependencyChange[] {
	const out: DependencyChange[] = [];
	for (const [scope, field] of DEP_SCOPES) {
		const a = (from[field] ?? {}) as Record<string, string>;
		const b = (to[field] ?? {}) as Record<string, string>;
		for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
			const lf = name in a ? lockedVersion(lockFrom, name) : undefined;
			const lt = name in b ? lockedVersion(lockTo, name) : undefined;
			const change: DependencyChange["change"] | undefined = !(name in a) ? "added" : !(name in b) ? "removed" : a[name] !== b[name] || lf !== lt ? "changed" : undefined;
			if (!change) continue;
			out.push({
				name,
				scope,
				change,
				...(name in a ? { from: a[name] } : {}),
				...(name in b ? { to: b[name] } : {}),
				...(lf !== undefined ? { lockedFrom: lf } : {}),
				...(lt !== undefined ? { lockedTo: lt } : {})
			});
		}
	}
	return out;
}

/** package.json deltas between the base and head sides, plus the breaking hints they imply. */
export function packageJsonDelta(from: Pkg, to: Pkg): { delta: NonNullable<NetFacts["packageJson"]>; hints: string[] } {
	const same = (k: string) => JSON.stringify(from[k]) === JSON.stringify(to[k]);
	const changed = ["version", "engines", "exports", "bin", "files", "publishConfig", "main", "type"].filter((k) => !same(k));
	const delta: NonNullable<NetFacts["packageJson"]> = { changed };
	const hints: string[] = [];
	if (!same("version")) delta.version = { ...(typeof from.version === "string" ? { from: from.version } : {}), ...(typeof to.version === "string" ? { to: to.version } : {}) };
	if (!same("engines")) {
		delta.engines = { from: from.engines, to: to.engines };
		hints.push(`engines changed: ${JSON.stringify(from.engines ?? null)} → ${JSON.stringify(to.engines ?? null)}`);
	}
	if (!same("exports")) {
		const a = exportKeys(from.exports);
		const b = exportKeys(to.exports);
		delta.exports = { added: b.filter((k) => !a.includes(k)), removed: a.filter((k) => !b.includes(k)) };
		for (const k of delta.exports.removed) hints.push(`exports entry removed: ${k}`);
	}
	return { delta, hints };
}

function emptyGroups(): Record<ChangeSection | "ungrouped", number[]> {
	return { breaking: [], features: [], fixes: [], security: [], ciTooling: [], documentation: [], dependencies: [], ungrouped: [] };
}

const HEADINGS: Record<ChangeSection | "ungrouped", string> = {
	breaking: "## ⚠️ Breaking Changes",
	features: "## ✨ Features",
	fixes: "## 🐛 Bug Fixes",
	security: "## 🔒 Security & supply chain",
	ciTooling: "## 🔧 CI & tooling",
	documentation: "## 📚 Documentation",
	dependencies: "## 🔧 Dependencies",
	ungrouped: "## 🔧 Other"
};

/** "Major" / "Minor" / "Patch" from the previous version to this one; null when either is unknown. */
export function releaseType(previous: string | null | undefined, version: string | null | undefined): string | null {
	if (!previous || !version) return null;
	const [a, b] = [previous, version].map((v) => v.split("-")[0]!.split(".").map(Number));
	if (b![0]! > a![0]!) return "Major";
	if (b![1]! > a![1]!) return "Minor";
	return "Patch";
}

/** A changelog skeleton in the per-version template: headings and one `(#N)` entry per PR, no prose. */
export function buildSkeleton(r: ReportReleaseChangesResult): string {
	const name = r.repo.split("/")[1];
	const type = releaseType(r.previousRelease?.version, r.version);
	const lines = [`# ${name} v${r.version ?? "X.Y.Z"} Changelog`, "", "**Release Date**: ", `**Release Type**: ${type ?? ""}`, "", "---", "", "## Overview", "", ""];
	const byNumber = new Map(r.prs.map((p) => [p.number, p]));
	for (const key of [...SECTIONS, "ungrouped"] as const) {
		const nums = r.groups[key];
		if (nums.length === 0) continue;
		lines.push("---", "", HEADINGS[key], "");
		for (const n of nums) {
			const p = byNumber.get(n)!;
			const closes = (p.closes ?? []).map((i) => `closes [#${i}](https://github.com/${r.repo}/issues/${i})`);
			lines.push(`### ${p.title} ([#${n}](${p.url})${closes.length ? `, ${closes.join(", ")}` : ""})`, "", "");
		}
	}
	lines.push("---", "", "## Upgrade notes", "", "");
	return lines.join("\n");
}

interface RawPull {
	number: number;
	title: string;
	html_url: string;
	body?: string | null;
	user: { login: string } | null;
	labels: Array<{ name: string }>;
	merged_at: string | null;
	additions: number;
	deletions: number;
	changed_files: number;
	head: { ref: string; sha: string };
	base: { ref: string };
}

interface RawFile {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	patch?: string;
}

interface RawCommit {
	sha: string;
	commit: { message: string };
}

/** A file's raw text at `ref`; undefined on 404. */
async function getRaw(octokit: Octokit, budget: CallBudget, owner: string, repo: string, path: string, ref: string): Promise<string | undefined> {
	try {
		const data = await reqOne<unknown>(octokit, budget, "GET /repos/{owner}/{repo}/contents/{path}", { owner, repo, path, ref, mediaType: { format: "raw" } });
		return typeof data === "string" ? data : undefined;
	} catch (err) {
		if (err instanceof RateLimited || err instanceof CallBudgetExhausted) throw err;
		if ((err as { status?: number }).status === 404) return undefined;
		throw err;
	}
}

async function getJson<T>(octokit: Octokit, budget: CallBudget, owner: string, repo: string, path: string, ref: string): Promise<T | undefined> {
	const text = await getRaw(octokit, budget, owner, repo, path, ref);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

/** First of `paths` that exists at `ref`, with its text. */
async function findText(octokit: Octokit, budget: CallBudget, owner: string, repo: string, paths: string[], ref: string): Promise<{ path: string; text: string } | undefined> {
	for (const path of paths) {
		const text = await getRaw(octokit, budget, owner, repo, path, ref);
		if (text !== undefined) return { path, text };
	}
	return undefined;
}

const isHotfixRef = (ref: string) => ref === "hotfixes" || ref.startsWith("hotfix/");

export async function reportReleaseChanges(octokit: Octokit, input: ReportReleaseChangesInput): Promise<ReportReleaseChangesResult> {
	const { owner, repo } = input;
	const budget = new CallBudget(Math.min(input.maxApiCalls ?? DEFAULT_MAX_API_CALLS, HARD_MAX_API_CALLS));
	const detail = input.detail ?? "summaries";
	const maxBodyChars = input.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
	const maxFiles = Math.min(input.maxFiles ?? DEFAULT_MAX_FILES, HARD_MAX_FILES);
	const maxPatchChars = input.maxPatchChars ?? DEFAULT_MAX_PATCH_CHARS;
	let diffLeft = input.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;
	const deep = input.prs ? new Set(input.prs) : undefined;
	const detailFor = (n: number): ChangeDetail => (deep && !deep.has(n) ? "titles" : detail);

	const result: ReportReleaseChangesResult = { repo: `${owner}/${repo}`, pull: input.pull, prs: [], groups: emptyGroups(), excluded: [], hotfixes: [] };

	try {
		const release = await reqOne<RawPull>(octokit, budget, "GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: input.pull });
		const head = release.head.ref;
		const base = release.base.ref;
		const version = parseReleaseVersion(release.title);
		Object.assign(result, { url: release.html_url, title: release.title, version, head, base });

		// 1. What the release PR's commits say ships (squash and merge commits, docs PRs and the bump dropped).
		const commits = await paginate<RawCommit>(octokit, budget, "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", { owner, repo, pull_number: input.pull }, 300);
		const candidates = releaseCommitPrs(commits.map((c) => c.commit.message));
		const inRange = new Set(candidates.map((c) => c.number));
		const drop = new Map<number, ExcludedPr>();
		for (const c of candidates) {
			const undone = revertedPr(c.title);
			if (undone !== undefined && inRange.has(undone)) {
				drop.set(c.number, { number: c.number, title: c.title, reason: "revert", pair: undone });
				drop.set(undone, { number: undone, title: candidates.find((x) => x.number === undone)!.title, reason: "reverted", pair: c.number });
			}
		}

		// 2. Earlier releases on the base branch: what they shipped, and which were hotfixes.
		const baseCommits = await reqOne<RawCommit[]>(octokit, budget, "GET /repos/{owner}/{repo}/commits", { owner, repo, sha: base, per_page: 50 });
		const releaseCommits = baseCommits.filter((c) => /^release:/i.test(c.commit.message)).slice(0, MAX_EARLIER_RELEASES);
		const shipped = new Set<number>();
		const hotfixCandidates: Array<HotfixRelease> = [];
		result.previousRelease = null;
		for (const rc of releaseCommits) {
			const subject = rc.commit.message.split("\n", 1)[0]!;
			const rcVersion = parseReleaseVersion(subject);
			const assoc = await reqOne<Array<{ number: number; title: string; html_url: string; head: { ref: string } }>>(octokit, budget, "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", { owner, repo, commit_sha: rc.sha });
			const pr = assoc[0];
			const hotfix = pr !== undefined && isHotfixRef(pr.head.ref);
			if (result.previousRelease === null) {
				result.previousRelease = { version: rcVersion, tag: rcVersion ? `v${rcVersion}` : null, ...(pr ? { pull: pr.number } : {}), sha: rc.sha, kind: hotfix ? "hotfix" : "full" };
			}
			if (pr) {
				const prCommits = await paginate<RawCommit>(octokit, budget, "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", { owner, repo, pull_number: pr.number }, 300);
				for (const s of releaseCommitPrs(prCommits.map((c) => c.commit.message))) shipped.add(s.number);
				if (hotfix && !isHotfixRef(head)) hotfixCandidates.push({ version: rcVersion, pull: pr.number, title: pr.title, url: pr.html_url, sha: rc.sha });
			}
			// Everything older than the last full release is covered by it.
			if (!hotfix) break;
		}
		if (hotfixCandidates.length > 0) {
			const cmp = await reqOne<{ commits?: RawCommit[] }>(octokit, budget, "GET /repos/{owner}/{repo}/compare/{basehead}", { owner, repo, basehead: `${head}...${base}` });
			const notOnHead = new Set((cmp.commits ?? []).map((c) => c.sha));
			result.hotfixes = hotfixCandidates.filter((h) => notOnHead.has(h.sha));
		}

		// 3. The previous version's changelog names what it shipped, too.
		const earlierChangelog = new Set<number>();
		const prevVersion = result.previousRelease?.version;
		if (prevVersion) {
			const found = await findText(octokit, budget, owner, repo, changelogPaths(prevVersion), base);
			if (found) for (const n of mentionedPrs(found.text)) earlierChangelog.add(n);
		}
		for (const c of candidates) {
			if (drop.has(c.number)) continue;
			if (shipped.has(c.number)) drop.set(c.number, { number: c.number, title: c.title, reason: "earlier-release" });
			else if (earlierChangelog.has(c.number)) drop.set(c.number, { number: c.number, title: c.title, reason: "earlier-changelog" });
		}
		result.excluded = [...drop.values()].sort((a, b) => a.number - b.number);

		// 4. The current version's changelog, if one exists yet, marks what is already written up.
		let documented = new Set<number>();
		if (version) {
			const paths = changelogPaths(version);
			const found = await findText(octokit, budget, owner, repo, paths, release.head.sha);
			result.changelog = { path: found?.path ?? null, checkedPaths: paths };
			if (found) documented = mentionedPrs(found.text);
		}

		const shipping = candidates.filter((c) => !drop.has(c.number));
		if (deep) {
			const missing = [...deep].filter((n) => !shipping.some((c) => c.number === n));
			if (missing.length > 0) result.notInRelease = missing;
		}
		result.prs = shipping.map((c) => ({
			number: c.number,
			url: `https://github.com/${owner}/${repo}/pull/${c.number}`,
			title: c.title,
			type: c.type,
			fetched: false,
			...(version ? { documented: documented.has(c.number) } : {})
		}));

		// 5. Each shipping PR at its detail level.
		for (const entry of result.prs) {
			const pr = await reqOne<RawPull>(octokit, budget, "GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: entry.number });
			const body = pr.body ?? "";
			const labels = pr.labels.map((l) => l.name);
			const conv = parseConventional(pr.title);
			Object.assign(entry, {
				url: pr.html_url,
				title: pr.title,
				type: commitType(pr.title),
				...(conv.scope ? { scope: conv.scope } : {}),
				fetched: true,
				labels,
				author: pr.user?.login ?? "",
				mergedAt: pr.merged_at,
				closes: closingIssues(body, owner, repo),
				additions: pr.additions,
				deletions: pr.deletions,
				changedFiles: pr.changed_files,
				breaking: breakingHints(pr.title, body, labels)
			});
			const level = DETAIL_RANK[detailFor(entry.number)];
			if (level >= DETAIL_RANK.summaries) {
				entry.body = body.length > maxBodyChars ? body.slice(0, maxBodyChars) : body;
				if (body.length > maxBodyChars) entry.bodyTruncated = true;
			}
			if (level >= DETAIL_RANK.files) {
				const files = await paginate<RawFile>(octokit, budget, "GET /repos/{owner}/{repo}/pulls/{pull_number}/files", { owner, repo, pull_number: entry.number }, maxFiles);
				entry.files = files.map((f) => {
					const file: ChangeFile = { path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions };
					if (level < DETAIL_RANK.diff || f.patch === undefined) return file;
					if (isGenerated(f.filename)) return { ...file, patchSkipped: "generated" };
					if (diffLeft <= 0) return { ...file, patchSkipped: "max-diff-chars" };
					const cap = Math.min(maxPatchChars, diffLeft);
					const patch = f.patch.length > cap ? f.patch.slice(0, cap) : f.patch;
					diffLeft -= patch.length;
					return { ...file, patch, ...(f.patch.length > cap ? { patchTruncated: true } : {}) };
				});
				if (pr.changed_files > files.length) entry.filesTruncated = true;
			}
		}

		// 6. The release's net facts.
		const net: NetFacts = { breakingHints: [] };
		result.net = net;
		const pkgFrom = await getJson<Pkg>(octokit, budget, owner, repo, "package.json", base);
		const pkgTo = await getJson<Pkg>(octokit, budget, owner, repo, "package.json", release.head.sha);
		if (pkgFrom && pkgTo) {
			const { delta, hints } = packageJsonDelta(pkgFrom, pkgTo);
			net.packageJson = delta;
			net.breakingHints.push(...hints);
			const lockFrom = await getJson<Lock>(octokit, budget, owner, repo, "package-lock.json", base);
			const lockTo = await getJson<Lock>(octokit, budget, owner, repo, "package-lock.json", release.head.sha);
			net.dependencies = dependencyChanges(pkgFrom, pkgTo, lockFrom, lockTo);
		}
		const files = await paginate<RawFile>(octokit, budget, "GET /repos/{owner}/{repo}/pulls/{pull_number}/files", { owner, repo, pull_number: input.pull }, RELEASE_FILES_LIMIT);
		const kept = files.filter((f) => !isGenerated(f.filename));
		const sum = (list: RawFile[], k: "additions" | "deletions") => list.reduce((n, f) => n + f[k], 0);
		net.files = {
			changed: release.changed_files,
			additions: release.additions,
			deletions: release.deletions,
			excludingGenerated: { changed: kept.length, additions: sum(kept, "additions"), deletions: sum(kept, "deletions") },
			complete: files.length >= release.changed_files
		};
	} catch (err) {
		if (err instanceof RateLimited) {
			result.truncated = true;
			result.truncatedReason = "rate-limited";
			if (err.retryAfterSeconds !== undefined) result.retryAfterSeconds = err.retryAfterSeconds;
		} else if (err instanceof CallBudgetExhausted) {
			result.truncated = true;
			result.truncatedReason = "max-api-calls";
		} else {
			throw err;
		}
	}

	// Grouping works on whatever was read; an unfetched PR is grouped from its commit title alone.
	for (const p of result.prs) {
		const section = sectionFor({ title: p.title, labels: p.labels ?? [], author: p.author ?? "", breaking: p.breaking ?? [] });
		if (section) p.section = section;
		result.groups[section ?? "ungrouped"].push(p.number);
	}
	if (input.skeleton && result.version !== undefined) result.skeleton = buildSkeleton(result);
	return result;
}

/** JSON Schema advertised to the agent for report_release_changes. */
export const REPORT_RELEASE_CHANGES_SCHEMA = {
	type: "object" as const,
	required: ["owner", "repo", "pull"],
	additionalProperties: false,
	properties: {
		owner: { type: "string", description: "repository owner (org/user login) — selects the read credential" },
		repo: { type: "string", description: "repository name" },
		pull: { type: "number", description: "the release PR number (next→master or hotfixes→master)" },
		detail: {
			type: "string",
			enum: ["titles", "summaries", "files", "diff"],
			description: "per-PR depth: titles (number, title, type, labels, author, merge date, closed issues), summaries (adds the body, capped), files (adds path/status/additions/deletions per file), diff (adds each file's patch, capped; lockfiles, dist/ and types/ skipped)",
			default: "summaries"
		},
		prs: { type: "array", items: { type: "number" }, description: "only these PRs get `detail`; every other shipping PR comes back at titles. Scan at titles first, then open just the ones that need judgment" },
		skeleton: { type: "boolean", description: "also return a changelog skeleton (markdown): headings per section and one (#N) entry per PR, no prose", default: false },
		maxBodyChars: { type: "number", description: `per-PR body cap (default ${DEFAULT_MAX_BODY_CHARS})` },
		maxFiles: { type: "number", description: `per-PR file-list cap (default ${DEFAULT_MAX_FILES}, hard cap ${HARD_MAX_FILES})` },
		maxPatchChars: { type: "number", description: `per-file patch cap with detail diff (default ${DEFAULT_MAX_PATCH_CHARS})` },
		maxDiffChars: { type: "number", description: `total patch characters across the report with detail diff (default ${DEFAULT_MAX_DIFF_CHARS})` },
		maxApiCalls: { type: "number", description: `hard ceiling on total REST calls this invocation makes (default ${DEFAULT_MAX_API_CALLS}, hard cap ${HARD_MAX_API_CALLS})` }
	}
};
