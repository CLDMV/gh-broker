/**
 * Release-readiness analysis for report_release_prs `analyze: true`.
 *
 * This is the decision logic the release-docs skill used to walk by hand: what is still open against
 * the release's integration branch, whether an existing changelog actually covers what merged, and
 * the resulting verdict. The pure helpers (parsing, classification, coverage, verdict) are exported
 * for tests; `analyzeRelease` does the reads.
 */

import type { Octokit } from "@octokit/core";
import { CallBudget, CallBudgetExhausted, RateLimited, paginate, reqOne } from "./rest-client.ts";

export type OpenPrKind = "doc" | "dependency" | "feature" | "draft";

export interface OpenPr {
	number: number;
	title: string;
	url: string;
	kind: OpenPrKind;
	/** Version named in a doc PR's title (`v1.2.3`), when it has one. */
	version?: string;
}

export type FreshnessStatus = "current" | "minor-gap" | "stale" | "version-drift" | "thin";

export interface CoverageGap {
	number: number;
	title: string;
}

export interface Freshness {
	status: FreshnessStatus;
	/** Non-doc PRs that shipped in this release (the expected coverage). */
	expectedPrs: number;
	/** User-facing PRs the changelog never mentions — these make it stale. */
	missingUserFacing: CoverageGap[];
	/** CI / chore / style / test PRs it never mentions — reported, but not stale on their own. */
	missingInternal: CoverageGap[];
	/** The changelog's own heading carries the release PR's current version. */
	headingMatchesVersion: boolean;
	/** The README What's New block names this version. */
	readmeMentionsVersion: boolean;
}

export type ReleaseVerdict = "done" | "in-flight" | "wait" | "gray" | "write" | "update" | "inspect";

export interface ReleaseAnalysis {
	openPrs: OpenPr[];
	/** Set only when a changelog file exists. */
	freshness?: Freshness;
	/** A doc PR's version differs from the release PR's current version. */
	docVersionMismatch?: boolean;
	verdict: ReleaseVerdict;
	/** One line explaining the verdict. */
	reason: string;
}

const INTERNAL_TYPES = new Set(["ci", "chore", "style", "test"]);

/** `feat(scope)!: x` -> `feat`. Returns "" when the subject is not conventional. */
export function commitType(subject: string): string {
	const m = /^([a-z]+)(?:\([^)]*\))?!?:/i.exec(subject.trim());
	return m ? m[1]!.toLowerCase() : "";
}

export interface ReleaseCommitPr {
	number: number;
	title: string;
	type: string;
}

/**
 * PR numbers shipped by a release, from the commits of its release PR. Only the first line of each
 * commit is read: squash bodies list other PR numbers and would fake coverage. Docs PRs (they describe
 * the release rather than being part of it) and the version bump are dropped.
 */
export function releaseCommitPrs(messages: string[]): ReleaseCommitPr[] {
	const seen = new Map<number, ReleaseCommitPr>();
	for (const message of messages) {
		const subject = message.split("\n", 1)[0]!.trim();
		let number: number | undefined;
		let title = subject;
		const squash = /\(#(\d+)\)\s*$/.exec(subject);
		const merge = /^Merge pull request #(\d+)\b/.exec(subject);
		if (squash) {
			number = Number(squash[1]);
			title = subject.slice(0, squash.index).trim();
		} else if (merge) {
			number = Number(merge[1]);
		}
		if (number === undefined) continue;
		const type = commitType(title);
		if (type === "docs" || /^chore: bump version/i.test(title)) continue;
		if (!seen.has(number)) seen.set(number, { number, title, type });
	}
	return [...seen.values()];
}

/** Every PR number a changelog mentions, by `#N` or `/pull/N`. */
export function mentionedPrs(changelog: string): Set<number> {
	const out = new Set<number>();
	for (const m of changelog.matchAll(/(?:#|\/pull\/)(\d+)\b/g)) out.add(Number(m[1]));
	return out;
}

export function classifyOpenPr(pr: { number: number; title: string; html_url: string; draft?: boolean; head?: { ref?: string }; user?: { login?: string }; labels?: Array<{ name?: string }> }): OpenPr {
	const title = pr.title;
	const labels = (pr.labels ?? []).map((l) => l.name ?? "");
	let kind: OpenPrKind;
	if (pr.draft) kind = "draft";
	else if (/^docs?(\([^)]*\))?!?:/i.test(title) || (pr.head?.ref ?? "").startsWith("docs/")) kind = "doc";
	else if (labels.includes("type: dependencies") || /^deps?(\([^)]*\))?!?:/i.test(title) || (pr.user?.login ?? "").toLowerCase().startsWith("dependabot")) kind = "dependency";
	else kind = "feature";
	const v = kind === "doc" ? /\bv?(\d+\.\d+\.\d+)\b/.exec(title) : null;
	return { number: pr.number, title, url: pr.html_url, kind, ...(v ? { version: v[1]! } : {}) };
}

export function assessFreshness(version: string, changelog: string, commits: ReleaseCommitPr[], readme: string | undefined): Freshness {
	const mentioned = mentionedPrs(changelog);
	const missing = commits.filter((c) => !mentioned.has(c.number));
	const missingUserFacing = missing.filter((c) => !INTERNAL_TYPES.has(c.type)).map(({ number, title }) => ({ number, title }));
	const missingInternal = missing.filter((c) => INTERNAL_TYPES.has(c.type)).map(({ number, title }) => ({ number, title }));
	const firstLine = changelog.split("\n", 1)[0] ?? "";
	const headingMatchesVersion = new RegExp(`v?${version.replace(/\./g, "\\.")}\\b`).test(firstLine);
	const readmeMentionsVersion = readme !== undefined && new RegExp(`Latest:\\s*v?${version.replace(/\./g, "\\.")}\\b`).test(readme);
	const thin = changelog.length < 400 || !/^##\s+Overview/m.test(changelog);
	let status: FreshnessStatus = "current";
	if (!headingMatchesVersion) status = "version-drift";
	else if (missingUserFacing.length > 0) status = "stale";
	else if (thin) status = "thin";
	else if (missingInternal.length > 0) status = "minor-gap";
	return { status, expectedPrs: commits.length, missingUserFacing, missingInternal, headingMatchesVersion, readmeMentionsVersion };
}

/** The release-docs decision table. */
export function decideVerdict(args: { hasChangelog: boolean; unknownVersion: boolean; freshness?: Freshness; openPrs: OpenPr[]; version: string | null }): { verdict: ReleaseVerdict; reason: string; docVersionMismatch?: boolean } {
	if (args.unknownVersion) return { verdict: "inspect", reason: "the release PR title has no `release: vX.Y.Z` version" };
	const f = args.freshness;
	if (args.hasChangelog && f && (f.status === "current" || f.status === "minor-gap")) {
		return { verdict: "done", reason: f.status === "minor-gap" ? `changelog covers every user-facing change; ${f.missingInternal.length} internal PR(s) not mentioned` : "changelog is current" };
	}
	const docs = args.openPrs.filter((p) => p.kind === "doc");
	const features = args.openPrs.filter((p) => p.kind === "feature");
	const others = args.openPrs.filter((p) => p.kind === "dependency" || p.kind === "draft");
	const need = args.hasChangelog ? `changelog is ${f?.status ?? "out of date"}` : "no changelog file";
	if (docs.length > 0) {
		const mismatch = args.version !== null && docs.some((d) => d.version !== undefined && d.version !== args.version);
		return { verdict: "in-flight", reason: `${need}; doc PR #${docs[0]!.number} is open`, ...(mismatch ? { docVersionMismatch: true } : {}) };
	}
	if (features.length > 0) return { verdict: "wait", reason: `${need}; ${features.length} feature/fix PR(s) still open against the release branch` };
	if (others.length > 0) return { verdict: "gray", reason: `${need}; only dependency PR(s) or drafts are open (${others.length})` };
	return { verdict: args.hasChangelog ? "update" : "write", reason: `${need}; nothing is open against the release branch` };
}

function decodeContent(data: unknown): string | undefined {
	const d = data as { content?: string; encoding?: string } | undefined;
	if (!d || typeof d.content !== "string") return undefined;
	return d.encoding === "base64" ? Buffer.from(d.content, "base64").toString("utf8") : d.content;
}

async function getText(octokit: Octokit, budget: CallBudget, owner: string, repo: string, path: string, ref: string): Promise<string | undefined> {
	try {
		return decodeContent(await reqOne(octokit, budget, "GET /repos/{owner}/{repo}/contents/{path}", { owner, repo, path, ref }));
	} catch (err) {
		if (err instanceof RateLimited || err instanceof CallBudgetExhausted) throw err;
		if ((err as { status?: number }).status === 404) return undefined;
		throw err;
	}
}

export async function analyzeRelease(
	octokit: Octokit,
	budget: CallBudget,
	args: { owner: string; repo: string; pull: number; head: string; version: string | null; changelogPath?: string }
): Promise<ReleaseAnalysis> {
	const { owner, repo } = args;
	const open = await paginate<Parameters<typeof classifyOpenPr>[0]>(octokit, budget, "GET /repos/{owner}/{repo}/pulls", { owner, repo, state: "open", base: args.head }, 200);
	const openPrs = open.map(classifyOpenPr);

	let freshness: Freshness | undefined;
	if (args.changelogPath && args.version) {
		const commits = await paginate<{ commit?: { message?: string } }>(octokit, budget, "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", { owner, repo, pull_number: args.pull }, 300);
		const changelog = (await getText(octokit, budget, owner, repo, args.changelogPath, args.head)) ?? "";
		const readme = await getText(octokit, budget, owner, repo, "README.md", args.head);
		freshness = assessFreshness(args.version, changelog, releaseCommitPrs(commits.map((c) => c.commit?.message ?? "")), readme);
	}
	const decision = decideVerdict({ hasChangelog: Boolean(args.changelogPath), unknownVersion: args.version === null, freshness, openPrs, version: args.version });
	return {
		openPrs,
		...(freshness ? { freshness } : {}),
		...(decision.docVersionMismatch ? { docVersionMismatch: true } : {}),
		verdict: decision.verdict,
		reason: decision.reason
	};
}
