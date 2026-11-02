/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/report_alert_status.ts
 *	@Date: 2026-11-01T00:00:00+00:00 (1793491200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T00:00:00+00:00 (1793491200)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import type { Octokit } from "@octokit/core";
import { CallBudget, CallBudgetExhausted, RateLimited, listOwnerRepos, paginate, paginateAfter, reqOne } from "./rest-client.ts";
import { normalizeDependabot, type RawDependabot, type SecurityAlert } from "./report_security_alerts.ts";
import { anyVulnerable, installedVersions, lockfileCandidates, lockfileKind } from "./lockfile.ts";

/**
 * Custom verb: report_alert_status — for every open Dependabot alert, where its fix stands.
 *
 * report_security_alerts says what is open; this answers the next question, "what has to
 * happen for each one?", which otherwise means reading lockfiles and PR lists by hand. Alert
 * state tracks the default branch, so an alert can read open while its fix is already merged
 * to `next`, or while a closed PR is the only history it has. Each alert gets one bucket:
 *
 *  - `released-still-open` — the default branch's lockfile no longer resolves a vulnerable
 *                            version, yet the alert is open (the fix didn't take).
 *  - `fixed-on-next`       — `next` or `hotfixes` resolves a patched version and the default
 *                            branch doesn't; waiting for a release.
 *  - `open-pr`             — an open PR bumps the package.
 *  - `closed-unmerged`     — only closed, unmerged PRs touch it.
 *  - `no-pr`               — nothing in flight.
 *
 * Checked in that order, so the bucket is the furthest the fix has got. Lockfiles are only
 * read for npm-ecosystem alerts; other ecosystems are bucketed from their PRs alone.
 *
 * Cost per repo: one repo read, three branch reads, the PR list (one call per 100 PRs) and the
 * lockfile reads. Lockfiles are read at a commit SHA and cached, so each lockfile is fetched
 * once per distinct commit — a `next` that equals the default branch costs nothing extra.
 * Fan-out safety mirrors the other report verbs: `maxApiCalls`, the rate-limit floor in
 * rest-client.ts, and `truncated` with a reason. Repos not reached are listed in `pending`.
 */

export type AlertBucket = "released-still-open" | "fixed-on-next" | "open-pr" | "closed-unmerged" | "no-pr";

const ALL_BUCKETS: AlertBucket[] = ["released-still-open", "fixed-on-next", "open-pr", "closed-unmerged", "no-pr"];

export interface ReportAlertStatusInput {
	owner: string;
	/** One repo. */
	repo?: string;
	/** Several repos (names, with or without the owner prefix), e.g. the `byRepo` of a report_security_alerts run. */
	repos?: string[];
	/** List only alerts in these buckets. `summary` and per-repo `counts` still cover every alert. */
	buckets?: AlertBucket[];
	/** Safety cap on repos swept when neither repo nor repos is given and the org endpoint is unavailable. Default 200, hard-capped at 500. */
	maxRepos?: number;
	/** Safety cap on alerts fetched (org mode) or per repo. Default 500, hard-capped at 5000. */
	alertLimit?: number;
	/** PRs read per repo, newest first. Default 200, hard-capped at 1000. */
	prLimit?: number;
	/** Lockfiles larger than this are not read. Default 10 MB, hard-capped at 50 MB. */
	maxLockfileBytes?: number;
	/** Hard ceiling on total REST calls for this invocation. Default 400, hard-capped at 2000. */
	maxApiCalls?: number;
}

export type LockfileUnknownReason = "no-lockfile" | "too-large" | "unparsed" | "no-version-info" | "no-branch";

export interface LockfileState {
	state: "fixed" | "vulnerable" | "unknown";
	/** The lockfile that was read. */
	path?: string;
	/** Versions of the package that lockfile resolves; empty when the package isn't in it. */
	versions?: string[];
	reason?: LockfileUnknownReason;
}

export interface PrRef {
	number: number;
	url: string;
	title: string;
	base: string;
	head: string;
	draft?: boolean;
	/** Set on a PR against the default branch when the hotfix redirector opened its `hotfix-redirect/pr-<n>` twin. */
	hotfixRedirect?: number;
}

export interface ClosedPrRef {
	number: number;
	url: string;
	title: string;
	closedAt: string;
	/** A PR for the same package merged after this one was closed. */
	supersededBy?: number;
}

export interface MergedPrRef {
	number: number;
	url: string;
	title: string;
	base: string;
	mergedAt: string;
}

export interface AlertStatus {
	number: number;
	url: string;
	severity: string;
	package: string;
	ecosystem?: string;
	manifest?: string;
	vulnerableRange?: string;
	patchedVersion?: string;
	createdAt: string;
	bucket: AlertBucket;
	/** One line saying why it landed in that bucket. */
	reason: string;
	/** npm-ecosystem alerts only. `next` / `hotfixes` are present only when the branch exists. */
	lockfile?: { default: LockfileState; next?: LockfileState; hotfixes?: LockfileState };
	openPrs: PrRef[];
	closedPrs?: ClosedPrRef[];
	mergedPrs?: MergedPrRef[];
}

export interface RepoAlertStatus {
	repo: string;
	defaultBranch: string;
	branches: { next: boolean; hotfixes: boolean };
	/** Hint only: whether Dependabot seems to have stopped opening PRs while fixable alerts keep arriving. */
	dependabot: { lastPrAt?: string; looksPaused: boolean; reason?: string };
	/** How many PRs were read; `prListTruncated` when the list hit `prLimit`, so older PRs were not seen. */
	prsScanned: number;
	prListTruncated?: boolean;
	counts: Partial<Record<AlertBucket, number>>;
	alerts: AlertStatus[];
}

export type AlertStatusTruncatedReason = "max-repos" | "max-alerts" | "max-api-calls" | "rate-limited";

export interface ReportAlertStatusResult {
	scanned: { repos: number; alerts: number };
	/** How the alerts were read: per named repo, one org-level call set, or a per-repo sweep after the org endpoint refused. */
	scope: "repo" | "org" | "per-repo";
	summary: Record<AlertBucket, number>;
	repos: RepoAlertStatus[];
	/** Repos with open alerts that a cap or the rate limit stopped before they were classified. */
	pending?: string[];
	/** Per-repo reads only: repos where Dependabot alerts are off or not readable. */
	disabled?: number;
	truncated?: boolean;
	truncatedReason?: AlertStatusTruncatedReason;
	/** Only set when truncatedReason is "rate-limited" and GitHub sent a Retry-After. */
	retryAfterSeconds?: number;
}

const DEFAULT_MAX_REPOS = 200;
const HARD_MAX_REPOS = 500;
const DEFAULT_ALERT_LIMIT = 500;
const HARD_ALERT_LIMIT = 5000;
const DEFAULT_PR_LIMIT = 200;
const HARD_PR_LIMIT = 1000;
const DEFAULT_MAX_LOCKFILE_BYTES = 10 * 1024 * 1024;
const HARD_MAX_LOCKFILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_API_CALLS = 400;
const HARD_MAX_API_CALLS = 2000;
/** A fixable alert this old with no Dependabot PR opened since it arrived counts toward "looks paused". */
const PAUSED_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const DEPENDABOT_LOGIN = "dependabot[bot]";

interface RawPull {
	number: number;
	html_url: string;
	title: string;
	body?: string | null;
	state: string;
	draft?: boolean;
	created_at: string;
	closed_at?: string | null;
	merged_at?: string | null;
	user?: { login?: string } | null;
	head: { ref: string };
	base: { ref: string };
}

interface RawContent {
	type?: string;
	size?: number;
	sha?: string;
	content?: string;
	encoding?: string;
}

/** The text of a lockfile, or a marker for one that exists but was too large to read. */
type LoadedLock = { path: string; text: string } | { path: string; tooLarge: true };

function isUnavailable(err: unknown): boolean {
	const status = (err as { status?: number }).status;
	return status === 403 || status === 404;
}

/** reqOne, with a 404 meaning "not there" instead of an error. */
async function getOrUndefined<T>(octokit: Octokit, budget: CallBudget, route: string, params: Record<string, unknown>): Promise<T | undefined> {
	try {
		return await reqOne<T>(octokit, budget, route, params);
	} catch (err) {
		if (err instanceof RateLimited || err instanceof CallBudgetExhausted) throw err;
		if ((err as { status?: number }).status === 404) return undefined;
		throw err;
	}
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A PR that looks like a dependency update: opened by Dependabot, on a Dependabot/redirect branch, or titled as a bump. */
function isDependencyPr(pr: RawPull): boolean {
	if (pr.user?.login === DEPENDABOT_LOGIN) return true;
	if (pr.head.ref.startsWith("dependabot/") || pr.head.ref.startsWith("hotfix-redirect/")) return true;
	return /\b(bumps?|updates?|upgrades?|deps)\b/i.test(pr.title);
}

/**
 * Whether a dependency PR touches `pkg`: the package named as a word in the title, or as a
 * Markdown link / code span in the body (how Dependabot's single and grouped PRs list it).
 */
function mentions(pr: RawPull, pkg: string): boolean {
	const esc = escapeRegExp(pkg);
	if (new RegExp(`(^|[\\s(\\[\`'"])${esc}(?=$|[\\s)\\]\`'":,])`).test(pr.title)) return true;
	const body = pr.body ?? "";
	return body.includes(`[${pkg}](`) || body.includes(`\`${pkg}\``);
}

function decode(content: string): string {
	return Buffer.from(content, "base64").toString("utf8");
}

export async function reportAlertStatus(octokit: Octokit, input: ReportAlertStatusInput): Promise<ReportAlertStatusResult> {
	const maxRepos = Math.min(input.maxRepos ?? DEFAULT_MAX_REPOS, HARD_MAX_REPOS);
	const alertLimit = Math.min(input.alertLimit ?? DEFAULT_ALERT_LIMIT, HARD_ALERT_LIMIT);
	const prLimit = Math.min(input.prLimit ?? DEFAULT_PR_LIMIT, HARD_PR_LIMIT);
	const maxLockfileBytes = Math.min(input.maxLockfileBytes ?? DEFAULT_MAX_LOCKFILE_BYTES, HARD_MAX_LOCKFILE_BYTES);
	const maxApiCalls = Math.min(input.maxApiCalls ?? DEFAULT_MAX_API_CALLS, HARD_MAX_API_CALLS);
	const budget = new CallBudget(maxApiCalls);
	const wantedBuckets = input.buckets?.length ? new Set(input.buckets) : undefined;

	const byRepo = new Map<string, SecurityAlert[]>();
	const results: RepoAlertStatus[] = [];
	const summary = Object.fromEntries(ALL_BUCKETS.map((b) => [b, 0])) as Record<AlertBucket, number>;
	let scope: ReportAlertStatusResult["scope"] = "repo";
	let disabled = 0;
	let alertCount = 0;
	let truncatedReason: AlertStatusTruncatedReason | undefined;
	let retryAfterSeconds: number | undefined;

	const add = (raws: unknown[], owner: string, repo: string) => {
		for (const raw of raws) {
			const a = normalizeDependabot(owner, repo, raw as RawDependabot);
			if (!a.package) continue; // nothing to match a lockfile or PR against
			const list = byRepo.get(a.repo) ?? [];
			list.push(a);
			byRepo.set(a.repo, list);
		}
	};

	const readRepos = async (repos: string[]) => {
		for (const repo of repos) {
			try {
				const raws = await paginateAfter<unknown>(octokit, budget, "GET /repos/{owner}/{repo}/dependabot/alerts", { owner: input.owner, repo, state: "open" }, alertLimit);
				if (raws.length >= alertLimit) truncatedReason ??= "max-alerts";
				add(raws, input.owner, repo);
			} catch (err) {
				if (!isUnavailable(err)) throw err;
				disabled++;
			}
		}
	};

	try {
		if (input.repo || input.repos?.length) {
			const named = input.repo ? [input.repo] : input.repos!.map((r) => r.replace(/^[^/]+\//, ""));
			await readRepos([...new Set(named)]);
		} else {
			try {
				const raws = await paginateAfter<unknown>(octokit, budget, "GET /orgs/{owner}/dependabot/alerts", { owner: input.owner, state: "open" }, alertLimit);
				scope = "org";
				if (raws.length >= alertLimit) truncatedReason ??= "max-alerts";
				add(raws, input.owner, "");
			} catch (err) {
				if (!isUnavailable(err)) throw err;
				scope = "per-repo";
				// One past the cap, so "exactly maxRepos repos" can be told apart from "more than maxRepos".
				const listed = await listOwnerRepos(octokit, budget, input.owner, maxRepos + 1);
				if (listed.length > maxRepos) truncatedReason ??= "max-repos";
				await readRepos(listed.slice(0, maxRepos));
			}
		}

		for (const full of [...byRepo.keys()].sort()) {
			const [owner, repo] = full.split("/") as [string, string];
			const row = await classifyRepoAlerts(octokit, budget, owner, repo, byRepo.get(full)!, { prLimit, maxLockfileBytes });
			alertCount += row.alerts.length;
			for (const a of row.alerts) summary[a.bucket]++;
			if (wantedBuckets) row.alerts = row.alerts.filter((a) => wantedBuckets.has(a.bucket));
			results.push(row);
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

	const done = new Set(results.map((r) => r.repo));
	const pending = [...byRepo.keys()].filter((r) => !done.has(r)).sort();
	return {
		scanned: { repos: results.length, alerts: alertCount },
		scope,
		summary,
		repos: results,
		...(pending.length > 0 ? { pending } : {}),
		...(disabled > 0 ? { disabled } : {}),
		...(truncatedReason ? { truncated: true, truncatedReason } : {}),
		...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {})
	};
}

async function classifyRepoAlerts(
	octokit: Octokit,
	budget: CallBudget,
	owner: string,
	repo: string,
	alerts: SecurityAlert[],
	opts: { prLimit: number; maxLockfileBytes: number }
): Promise<RepoAlertStatus> {
	const info = await reqOne<{ default_branch: string }>(octokit, budget, "GET /repos/{owner}/{repo}", { owner, repo });
	const defaultBranch = info.default_branch;
	const branchSha = async (branch: string) =>
		(await getOrUndefined<{ commit: { sha: string } }>(octokit, budget, "GET /repos/{owner}/{repo}/branches/{branch}", { owner, repo, branch }))?.commit.sha;
	const defaultSha = await branchSha(defaultBranch);
	const nextSha = await branchSha("next");
	const hotfixesSha = await branchSha("hotfixes");

	const pulls = await paginate<RawPull>(octokit, budget, "GET /repos/{owner}/{repo}/pulls", { owner, repo, state: "all", sort: "created", direction: "desc" }, opts.prLimit);
	const depPulls = pulls.filter(isDependencyPr);

	// Lockfile text per commit + path; null caches a miss so a missing file is asked for once.
	const lockCache = new Map<string, LoadedLock | null>();
	const loadLock = async (sha: string, path: string): Promise<LoadedLock | null> => {
		const key = `${sha}:${path}`;
		if (lockCache.has(key)) return lockCache.get(key)!;
		let loaded: LoadedLock | null = null;
		const meta = await getOrUndefined<RawContent | RawContent[]>(octokit, budget, "GET /repos/{owner}/{repo}/contents/{path}", { owner, repo, path, ref: sha });
		if (meta && !Array.isArray(meta) && meta.type === "file") {
			if ((meta.size ?? 0) > opts.maxLockfileBytes) {
				loaded = { path, tooLarge: true };
			} else if (meta.encoding === "base64" && meta.content) {
				loaded = { path, text: decode(meta.content) };
			} else {
				// Files over 1 MB come back from the contents API without a body; the blob API serves them.
				const blob = await reqOne<{ content: string }>(octokit, budget, "GET /repos/{owner}/{repo}/git/blobs/{file_sha}", { owner, repo, file_sha: meta.sha });
				loaded = { path, text: decode(blob.content) };
			}
		}
		lockCache.set(key, loaded);
		return loaded;
	};
	const findLock = async (sha: string, manifest: string): Promise<LoadedLock | null> => {
		for (const path of lockfileCandidates(manifest)) {
			const lock = await loadLock(sha, path);
			if (lock) return lock;
		}
		return null;
	};
	const lockState = async (sha: string | undefined, a: SecurityAlert): Promise<LockfileState> => {
		if (!sha) return { state: "unknown", reason: "no-branch" };
		const lock = await findLock(sha, a.manifest ?? "package-lock.json");
		if (!lock) return { state: "unknown", reason: "no-lockfile" };
		if ("tooLarge" in lock) return { state: "unknown", path: lock.path, reason: "too-large" };
		const versions = installedVersions(lockfileKind(lock.path)!, lock.text, a.package!);
		if (!versions) return { state: "unknown", path: lock.path, reason: "unparsed" };
		const vuln = anyVulnerable(versions, a.vulnerableRange, a.patchedVersion);
		if (vuln === undefined) return { state: "unknown", path: lock.path, versions, reason: "no-version-info" };
		return { state: vuln ? "vulnerable" : "fixed", path: lock.path, versions };
	};

	const statuses: AlertStatus[] = [];
	for (const a of alerts) {
		const pkg = a.package!;
		const touching = depPulls.filter((p) => mentions(p, pkg));
		const open = touching.filter((p) => p.state === "open");
		const merged = touching.filter((p) => p.merged_at);
		const closed = touching.filter((p) => p.state !== "open" && !p.merged_at);

		const openPrs: PrRef[] = open.map((p) => {
			const twin = p.base.ref === defaultBranch ? open.find((t) => t.head.ref === `hotfix-redirect/pr-${p.number}`) : undefined;
			return {
				number: p.number,
				url: p.html_url,
				title: p.title,
				base: p.base.ref,
				head: p.head.ref,
				...(p.draft ? { draft: true } : {}),
				...(twin ? { hotfixRedirect: twin.number } : {})
			};
		});
		const closedPrs: ClosedPrRef[] = closed.map((p) => {
			const closedAt = p.closed_at ?? p.created_at;
			const later = merged.filter((m) => m.merged_at! > closedAt).sort((x, y) => x.merged_at!.localeCompare(y.merged_at!))[0];
			return { number: p.number, url: p.html_url, title: p.title, closedAt, ...(later ? { supersededBy: later.number } : {}) };
		});
		const mergedPrs: MergedPrRef[] = merged.map((p) => ({ number: p.number, url: p.html_url, title: p.title, base: p.base.ref, mergedAt: p.merged_at! }));

		let lockfile: AlertStatus["lockfile"];
		if (a.ecosystem === "npm") {
			const def = await lockState(defaultSha, a);
			lockfile = { default: def };
			if (nextSha) lockfile.next = await lockState(nextSha, a);
			if (hotfixesSha) lockfile.hotfixes = await lockState(hotfixesSha, a);
		}

		let bucket: AlertBucket;
		let reason: string;
		const stagedOn = lockfile ? (["next", "hotfixes"] as const).find((b) => lockfile![b]?.state === "fixed") : undefined;
		if (lockfile?.default.state === "fixed") {
			bucket = "released-still-open";
			reason = `${lockfile.default.path} on ${defaultBranch} has no vulnerable ${pkg} (${lockfile.default.versions!.join(", ") || "not present"}), but the alert is still open`;
		} else if (stagedOn) {
			bucket = "fixed-on-next";
			reason = `${stagedOn} resolves ${pkg} ${lockfile![stagedOn]!.versions!.join(", ") || "(removed)"}; waiting for a release`;
		} else if (openPrs.length > 0) {
			bucket = "open-pr";
			reason = `open PR #${openPrs.map((p) => p.number).join(", #")}`;
		} else if (closedPrs.length > 0) {
			bucket = "closed-unmerged";
			const superseded = closedPrs.filter((p) => p.supersededBy !== undefined).length;
			reason = `${closedPrs.length} closed unmerged PR(s)${superseded > 0 ? `, ${superseded} superseded by a later merge` : ""}`;
		} else {
			bucket = "no-pr";
			reason = mergedPrs.length > 0 ? `no open PR; ${mergedPrs.length} merged PR(s) did not clear it` : "no PR for this package";
		}

		statuses.push({
			number: a.number,
			url: a.url,
			severity: a.severity,
			package: pkg,
			...(a.ecosystem ? { ecosystem: a.ecosystem } : {}),
			...(a.manifest ? { manifest: a.manifest } : {}),
			...(a.vulnerableRange ? { vulnerableRange: a.vulnerableRange } : {}),
			...(a.patchedVersion ? { patchedVersion: a.patchedVersion } : {}),
			createdAt: a.createdAt,
			bucket,
			reason,
			...(lockfile ? { lockfile } : {}),
			openPrs,
			...(closedPrs.length > 0 ? { closedPrs } : {}),
			...(mergedPrs.length > 0 ? { mergedPrs } : {})
		});
	}

	// Paused hint: fixable alerts older than a week with no Dependabot PR opened since they arrived.
	const lastPrAt = pulls
		.filter((p) => p.user?.login === DEPENDABOT_LOGIN)
		.map((p) => p.created_at)
		.sort()
		.at(-1);
	const cutoff = new Date(Date.now() - PAUSED_AFTER_MS).toISOString();
	const unanswered = alerts.filter((a) => a.patchedVersion && a.createdAt < cutoff && (!lastPrAt || a.createdAt > lastPrAt));
	const dependabot: RepoAlertStatus["dependabot"] = {
		...(lastPrAt ? { lastPrAt } : {}),
		looksPaused: unanswered.length > 0,
		...(unanswered.length > 0
			? { reason: `${unanswered.length} fixable alert(s) older than 7 days with no Dependabot PR opened since${lastPrAt ? ` (last one ${lastPrAt})` : " (none in the PRs read)"}` }
			: {})
	};

	const counts: Partial<Record<AlertBucket, number>> = {};
	for (const s of statuses) counts[s.bucket] = (counts[s.bucket] ?? 0) + 1;
	statuses.sort((x, y) => ALL_BUCKETS.indexOf(x.bucket) - ALL_BUCKETS.indexOf(y.bucket) || x.number - y.number);

	return {
		repo: `${owner}/${repo}`,
		defaultBranch,
		branches: { next: nextSha !== undefined, hotfixes: hotfixesSha !== undefined },
		dependabot,
		prsScanned: pulls.length,
		...(pulls.length >= opts.prLimit ? { prListTruncated: true } : {}),
		counts,
		alerts: statuses
	};
}

/** JSON Schema advertised to the agent for report_alert_status. */
export const REPORT_ALERT_STATUS_SCHEMA = {
	type: "object" as const,
	required: ["owner"],
	additionalProperties: false,
	properties: {
		owner: { type: "string", description: "repository owner (org/user login) — selects the read credential" },
		repo: { type: "string", description: "one repository; omit (with repos) to cover every repo with open Dependabot alerts" },
		repos: { type: "array", items: { type: "string" }, description: "several repositories (names, with or without the owner prefix), e.g. the byRepo list of a report_security_alerts run" },
		buckets: {
			type: "array",
			items: { type: "string", enum: ALL_BUCKETS },
			description: "list only alerts in these buckets; summary and per-repo counts still cover every alert"
		},
		maxRepos: { type: "number", description: `safety cap on repos swept when the org-level endpoint is unavailable (default ${DEFAULT_MAX_REPOS}, hard cap ${HARD_MAX_REPOS})` },
		alertLimit: { type: "number", description: `safety cap on alerts fetched (org mode) or per repo (default ${DEFAULT_ALERT_LIMIT}, hard cap ${HARD_ALERT_LIMIT})` },
		prLimit: { type: "number", description: `PRs read per repo, newest first (default ${DEFAULT_PR_LIMIT}, hard cap ${HARD_PR_LIMIT})` },
		maxLockfileBytes: { type: "number", description: `lockfiles larger than this are not read (default ${DEFAULT_MAX_LOCKFILE_BYTES}, hard cap ${HARD_MAX_LOCKFILE_BYTES})` },
		maxApiCalls: { type: "number", description: `hard ceiling on total REST calls this invocation makes (default ${DEFAULT_MAX_API_CALLS}, hard cap ${HARD_MAX_API_CALLS})` }
	}
};
