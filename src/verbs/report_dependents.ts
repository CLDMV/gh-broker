/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/report_dependents.ts
 *	@Date: 2026-10-03T05:10:00+00:00 (1791004200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-03T05:10:00+00:00 (1791004200)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import type { Octokit } from "@octokit/core";
import { CallBudget, CallBudgetExhausted, RateLimited, reqOne } from "./rest-client.ts";
import { classifyRepo, type RepoTier } from "./repo-tier.ts";
import { latestVersion, type FetchLike } from "./npm-registry.ts";

/**
 * Custom verb: report_dependents — every repo an owner has that declares a given npm
 * package, with the declared range, the version the lockfile resolved, and the repo's flow tier.
 *
 * Built for the fleet-update skills (bump fix-headers / vitest-runner / slothlet), which all
 * start by finding every consumer of one package. Discovery is ONE org-wide code search for
 * the package name restricted to `package.json` files; every candidate is then verified by
 * reading the manifest at the repo's default branch. The search is only a candidate list:
 * GitHub's index lags new commits, only covers the default branch, and caps at 1000 hits, so
 * a repo whose manifest changed recently may be missing from it. The result says so
 * (`discovery.note`) and reports `incomplete-search` / `max-results` when the search itself
 * tells us it is partial.
 *
 * Dev branches: because the search never sees non-default branches, a second pass (on by
 * default, `devBranches: false` skips it) lists every repo with a `dev` branch that differs
 * from its default branch — one GraphQL page per 100 repos — and reads every `package.json`
 * in that branch's tree. That is where a dev-trunk repo's real manifests live. A repo that
 * declares the package on both branches is reported twice, once per `branch`. A `dev` whose
 * root package.json version is below the default branch's has been left behind by a release,
 * so it is treated as abandoned: skipped, and listed in `abandonedDev`.
 *
 * Workspace members: a `package.json` below the repo root that declares the package is
 * reported against its repo with the member path, and resolved against the repo's root
 * lockfile (`package-lock.json` or `pnpm-lock.yaml`; other lockfiles are not read).
 *
 * Fan-out safety mirrors the other report verbs (see rest-client.ts): `maxRepos`,
 * `maxFileBytes` and `maxApiCalls` cap the work; hitting a cap or GitHub's rate limit
 * returns whatever was verified with `truncated: true` and a reason.
 */

export interface ReportDependentsInput {
	owner: string;
	/** npm package name, e.g. `@cldmv/fix-headers`. */
	name: string;
	/** Compare each resolved version with the latest published one and set `behind`. Default false. */
	latest?: boolean;
	/** Add each repo's flow tier (`v4` / `dev-trunk` / `non-v4`) and signals. About 3 REST calls per dependent repo. Default true. */
	classify?: boolean;
	/** Also read the manifests on every `dev` branch that differs from its repo's default branch. Default true. */
	devBranches?: boolean;
	/** Safety cap on candidate repos verified. Default 200, hard-capped at 500. */
	maxRepos?: number;
	/** Largest file (package.json or lockfile) that is read; bigger ones are listed in `unread`. Default 5 MB, hard-capped at 20 MB. */
	maxFileBytes?: number;
	/** Hard ceiling on total REST calls for this invocation. Default 600, hard-capped at 3000. */
	maxApiCalls?: number;
}

export type DependencyField = "dependencies" | "devDependencies" | "peerDependencies";

const FIELDS: DependencyField[] = ["dependencies", "devDependencies", "peerDependencies"];

export interface Declaration {
	/** Path of the declaring package.json within the repo. */
	path: string;
	/** Workspace member directory; absent for the root package.json. */
	member?: string;
	declared: { field: DependencyField; range: string }[];
	/** Version the lockfile resolved for this package.json; absent when no readable lockfile has it. */
	resolved?: string;
	/** Only with `latest`: the resolved version is older than the latest published one. */
	behind?: boolean;
}

export interface Dependent {
	repo: string;
	private: boolean;
	defaultBranch: string;
	/** Branch the manifests and lockfile were read from: the default branch, or `dev`. */
	branch: string;
	/** Only with `classify`. */
	tier?: RepoTier["tier"];
	tierSignals?: RepoTier["signals"];
	/** The lockfile the resolved versions came from. */
	lockfile?: string;
	declarations: Declaration[];
	/** Files that could not be read or parsed, with why. Omitted when none. */
	unread?: { path: string; reason: "missing" | "too-large" | "invalid-json" | "tree-truncated" }[];
}

export interface AbandonedDev {
	repo: string;
	devVersion: string;
	defaultVersion: string;
}

export type DependentsTruncatedReason = "max-results" | "incomplete-search" | "max-repos" | "max-api-calls" | "rate-limited";

export interface ReportDependentsResult {
	package: string;
	/** Only with `latest`; absent when the lookup failed (see `latestError`) or the package is unpublished. */
	latest?: string;
	latestError?: string;
	discovery: { source: "code-search"; devBranches: boolean; note: string };
	scanned: {
		/** Distinct repos the search returned. */
		candidates: number;
		/** Candidates that turned out to be archived. */
		archived: number;
		/** Candidates that turned out to be forks. */
		forks: number;
		/** Candidates that were gone by the time they were read (search lag). */
		missing: number;
		/** Verified repos whose package.json files do not declare the package (the name only appeared in the text). */
		notDeclared: number;
		/** Repos whose separate `dev` branch was read. Only with `devBranches`. */
		devBranches?: number;
	};
	dependents: Dependent[];
	/** Only with `devBranches`: repos whose `dev` was skipped because its root package.json version is below the default branch's. Omitted when none. */
	abandonedDev?: AbandonedDev[];
	truncated?: boolean;
	truncatedReason?: DependentsTruncatedReason;
	/** Only set when truncatedReason is "rate-limited" and GitHub sent a Retry-After. */
	retryAfterSeconds?: number;
}

const DEFAULT_MAX_REPOS = 200;
const HARD_MAX_REPOS = 500;
const DEFAULT_MAX_FILE_BYTES = 5_000_000;
const HARD_MAX_FILE_BYTES = 20_000_000;
const DEFAULT_MAX_API_CALLS = 600;
const HARD_MAX_API_CALLS = 3000;
const SEARCH_PAGE_SIZE = 100;
/** GitHub serves at most 1000 search results, i.e. 10 pages of 100. */
const SEARCH_MAX_PAGES = 10;
const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml"];
const NAME_PATTERN = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
/** GraphQL pages of 100 repos read when listing dev branches. */
const DEV_LIST_MAX_PAGES = 20;
const DEV_BRANCH = "dev";
const SEARCH_NOTE =
	"Candidates come from GitHub code search, which lags recent commits and only indexes default branches; each candidate was verified against its default-branch package.json. A repo that changed very recently can be missing.";
const DEV_NOTE =
	" Every `dev` branch that differs from its default branch was also read in full, so dev-trunk repos are included; a `dev` whose root package.json version is below the default branch's is treated as abandoned and skipped (see `abandonedDev`).";
const NO_DEV_NOTE = " Dev branches were not read, so a dev-trunk repo whose real manifests live on `dev` is missing.";
const DEV_BRANCHES_QUERY = `query($owner: String!, $after: String) {
  repositoryOwner(login: $owner) {
    repositories(first: 100, after: $after, orderBy: { field: NAME, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        isArchived
        isFork
        isPrivate
        defaultBranchRef { name target { oid ...manifest } }
        dev: ref(qualifiedName: "refs/heads/${DEV_BRANCH}") { target { oid ...manifest } }
      }
    }
  }
}
fragment manifest on Commit { file(path: "package.json") { object { ... on Blob { text } } } }`;

interface SearchHit {
	path: string;
	repository: { name: string; owner: { login: string } };
}

interface SearchResponse {
	total_count: number;
	incomplete_results: boolean;
	items: SearchHit[];
}

interface RawRepo {
	archived?: boolean;
	fork?: boolean;
	private?: boolean;
	default_branch: string;
}

interface DevBranchesResponse {
	data?: {
		repositoryOwner: {
			repositories: {
				pageInfo: { hasNextPage: boolean; endCursor: string | null };
				nodes: {
					name: string;
					isArchived: boolean;
					isFork: boolean;
					isPrivate: boolean;
					defaultBranchRef: { name: string; target: CommitWithManifest } | null;
					dev: { target: CommitWithManifest } | null;
				}[];
			};
		} | null;
	};
	errors?: { message: string }[];
}

interface CommitWithManifest {
	oid: string;
	file?: { object?: { text?: string | null } | null } | null;
}

/** `version` from a commit's root package.json, or undefined when it is missing, unreadable or has none. */
function manifestVersion(commit: CommitWithManifest): string | undefined {
	const text = commit.file?.object?.text;
	if (!text) return undefined;
	try {
		const v = (JSON.parse(text) as { version?: unknown }).version;
		return typeof v === "string" ? v : undefined;
	} catch {
		return undefined;
	}
}

interface RawTree {
	truncated: boolean;
	tree: { path: string; type: string }[];
}

interface RawFile {
	size: number;
	content?: string;
}

/** Numeric parts of `1.2.3-pre`, padded to three, and whether a prerelease tag follows. */
function parseVersion(v: string): { nums: number[]; pre: boolean } {
	const [core = "", pre] = v.split(/-(.+)/);
	const parts = core.split(".").map(Number);
	return { nums: [0, 1, 2].map((i) => parts[i] || 0), pre: pre !== undefined };
}

/** True when `resolved` is an older version than `latest` (a prerelease sorts below its release). */
export function isBehind(resolved: string, latest: string): boolean {
	const a = parseVersion(resolved);
	const b = parseVersion(latest);
	for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i]! < b.nums[i]!;
	return a.pre && !b.pre;
}

/** Version of `name` in an npm lockfile (v2/v3 `packages`, v1 `dependencies`) for the workspace `member` (`.` = root). */
function resolveNpmLock(text: string, member: string, name: string): string | undefined {
	const lock = JSON.parse(text) as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
	// Node resolves a member's own node_modules first, then the hoisted root copy.
	const key = member === "." ? `node_modules/${name}` : `${member}/node_modules/${name}`;
	return lock.packages?.[key]?.version ?? lock.packages?.[`node_modules/${name}`]?.version ?? lock.dependencies?.[name]?.version;
}

/** Version of `name` under the `importers:` entry for `member` in a pnpm lockfile (v6+ layout), or undefined. */
function resolvePnpmLock(text: string, member: string, name: string): string | undefined {
	let inImporters = false;
	let importer: string | undefined;
	let dep: string | undefined;
	for (const line of text.split("\n")) {
		if (/^\S/.test(line)) {
			inImporters = line.startsWith("importers:");
			importer = undefined;
			continue;
		}
		if (!inImporters) continue;
		let m = /^ {2}(?=\S)(['"]?)(.+?)\1:\s*$/.exec(line);
		if (m) {
			importer = m[2];
			dep = undefined;
			continue;
		}
		if (importer !== member) continue;
		m = /^ {6}(?=\S)(['"]?)(.+?)\1:\s*$/.exec(line);
		if (m) {
			dep = m[2];
			continue;
		}
		if (dep === name) {
			m = /^ {8}version:\s*['"]?(\d[^\s'"(_]*)/.exec(line);
			if (m) return m[1];
		}
	}
	return undefined;
}

type ReadResult = { text: string } | { skipped: "missing" | "too-large" };

/** Reads a file at `ref`: JSON metadata first (carries `size`), raw media type only for files the API leaves out (over 1 MB). */
async function readFile(octokit: Octokit, budget: CallBudget, owner: string, repo: string, path: string, ref: string, maxBytes: number): Promise<ReadResult> {
	let meta: RawFile;
	try {
		meta = await reqOne<RawFile>(octokit, budget, "GET /repos/{owner}/{repo}/contents/{path}", { owner, repo, path, ref });
	} catch (err) {
		if ((err as { status?: number }).status !== 404) throw err;
		return { skipped: "missing" };
	}
	if (meta.size > maxBytes) return { skipped: "too-large" };
	if (meta.content) return { text: Buffer.from(meta.content, "base64").toString("utf8") };
	const raw = await reqOne<string>(octokit, budget, "GET /repos/{owner}/{repo}/contents/{path}", {
		owner,
		repo,
		path,
		ref,
		headers: { accept: "application/vnd.github.raw+json" }
	});
	return { text: String(raw) };
}

export interface ReportDependentsDeps {
	/** Injected for tests; defaults to global fetch. */
	fetch?: FetchLike;
	/** npm registry base URL for the `latest` lookup; defaults to registry.npmjs.org. */
	registry?: string;
}

interface RepoRef {
	name: string;
	private: boolean;
	defaultBranch: string;
}

interface ScanContext {
	octokit: Octokit;
	budget: CallBudget;
	owner: string;
	name: string;
	maxBytes: number;
	latest?: string;
}

/** Reads `paths` on `branch` and returns the repo's entry, or undefined when none of them declares the package. */
async function scanBranch(ctx: ScanContext, repo: RepoRef, branch: string, paths: string[], unread: NonNullable<Dependent["unread"]> = []): Promise<Dependent | undefined> {
	const { octokit, budget, owner, name, maxBytes, latest } = ctx;
	const declarations: Declaration[] = [];
	for (const path of [...paths].sort()) {
		const file = await readFile(octokit, budget, owner, repo.name, path, branch, maxBytes);
		if ("skipped" in file) {
			unread.push({ path, reason: file.skipped });
			continue;
		}
		let manifest: Record<string, unknown>;
		try {
			manifest = JSON.parse(file.text) as Record<string, unknown>;
		} catch {
			unread.push({ path, reason: "invalid-json" });
			continue;
		}
		const declared: Declaration["declared"] = [];
		for (const field of FIELDS) {
			const range = (manifest[field] as Record<string, unknown> | undefined)?.[name];
			if (typeof range === "string") declared.push({ field, range });
		}
		if (declared.length === 0) continue;
		const dir = path.slice(0, -"package.json".length).replace(/\/$/, "");
		declarations.push({ path, ...(dir ? { member: dir } : {}), declared });
	}
	if (declarations.length === 0 && unread.length === 0) return undefined;

	const entry: Dependent = { repo: `${owner}/${repo.name}`, private: repo.private, defaultBranch: repo.defaultBranch, branch, declarations };
	if (unread.length > 0) entry.unread = unread;
	if (declarations.length === 0) return entry;

	for (const lockfile of LOCKFILES) {
		const file = await readFile(octokit, budget, owner, repo.name, lockfile, branch, maxBytes);
		if ("skipped" in file) {
			if (file.skipped === "too-large") (entry.unread ??= []).push({ path: lockfile, reason: "too-large" });
			continue;
		}
		const resolve = lockfile === "package-lock.json" ? resolveNpmLock : resolvePnpmLock;
		try {
			for (const d of declarations) {
				const resolved = resolve(file.text, d.member ?? ".", name);
				if (resolved === undefined) continue;
				d.resolved = resolved;
				if (latest !== undefined) d.behind = isBehind(resolved, latest);
			}
		} catch {
			(entry.unread ??= []).push({ path: lockfile, reason: "invalid-json" });
			continue;
		}
		entry.lockfile = lockfile;
		break;
	}
	return entry;
}

/**
 * Non-archived, non-fork repos whose `dev` branch exists and points somewhere other than the default
 * branch. A `dev` whose root package.json version is below the default branch's has fallen behind
 * a release and is listed as abandoned instead; with either version missing it is kept.
 */
async function listDevBranches(octokit: Octokit, budget: CallBudget, owner: string): Promise<{ repos: RepoRef[]; abandoned: AbandonedDev[]; complete: boolean }> {
	const repos: RepoRef[] = [];
	const abandoned: AbandonedDev[] = [];
	let after: string | null = null;
	for (let page = 1; page <= DEV_LIST_MAX_PAGES; page++) {
		const res: DevBranchesResponse = await reqOne<DevBranchesResponse>(octokit, budget, "POST /graphql", { query: DEV_BRANCHES_QUERY, variables: { owner, after } });
		const conn = res.data?.repositoryOwner?.repositories;
		if (!conn) throw new Error(`report_dependents: listing dev branches failed: ${res.errors?.map((e) => e.message).join("; ") ?? `no owner "${owner}"`}`);
		for (const r of conn.nodes) {
			if (r.isArchived || r.isFork || !r.dev || !r.defaultBranchRef) continue;
			if (r.dev.target.oid === r.defaultBranchRef.target.oid) continue;
			const devVersion = manifestVersion(r.dev.target);
			const defaultVersion = manifestVersion(r.defaultBranchRef.target);
			if (devVersion !== undefined && defaultVersion !== undefined && isBehind(devVersion, defaultVersion)) {
				abandoned.push({ repo: `${owner}/${r.name}`, devVersion, defaultVersion });
				continue;
			}
			repos.push({ name: r.name, private: r.isPrivate, defaultBranch: r.defaultBranchRef.name });
		}
		if (!conn.pageInfo.hasNextPage) return { repos, abandoned, complete: true };
		after = conn.pageInfo.endCursor;
	}
	return { repos, abandoned, complete: false };
}

export async function reportDependents(octokit: Octokit, input: ReportDependentsInput, deps: ReportDependentsDeps = {}): Promise<ReportDependentsResult> {
	if (!NAME_PATTERN.test(input.name)) throw new Error(`report_dependents: "${input.name}" is not a valid npm package name`);
	const maxRepos = Math.min(input.maxRepos ?? DEFAULT_MAX_REPOS, HARD_MAX_REPOS);
	const maxBytes = Math.min(input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, HARD_MAX_FILE_BYTES);
	const budget = new CallBudget(Math.min(input.maxApiCalls ?? DEFAULT_MAX_API_CALLS, HARD_MAX_API_CALLS));
	const { owner, name } = input;
	const devBranches = input.devBranches !== false;

	const dependents: Dependent[] = [];
	const scanned: ReportDependentsResult["scanned"] = { candidates: 0, archived: 0, forks: 0, missing: 0, notDeclared: 0, ...(devBranches ? { devBranches: 0 } : {}) };
	let truncatedReason: DependentsTruncatedReason | undefined;
	let retryAfterSeconds: number | undefined;
	const abandonedDev: AbandonedDev[] = [];

	let latest: string | undefined;
	let latestError: string | undefined;
	if (input.latest) {
		try {
			latest = await latestVersion(name, { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.registry ? { registry: deps.registry } : {}) });
		} catch (err) {
			latestError = (err as Error).message;
		}
	}
	const ctx: ScanContext = { octokit, budget, owner, name, maxBytes, ...(latest !== undefined ? { latest } : {}) };
	const tiers = new Map<string, RepoTier>();
	const classify = async (entry: Dependent, repo: string): Promise<void> => {
		if (input.classify === false || entry.declarations.length === 0) return;
		let t = tiers.get(repo);
		if (!t) {
			t = await classifyRepo(octokit, budget, owner, repo, entry.defaultBranch);
			tiers.set(repo, t);
		}
		entry.tier = t.tier;
		entry.tierSignals = t.signals;
	};

	try {
		// Candidate manifests, grouped by repo.
		const byRepo = new Map<string, Set<string>>();
		const hits: SearchHit[] = [];
		for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
			const res = await reqOne<SearchResponse>(
				octokit,
				budget,
				"GET /search/code",
				{ q: `"${name}" org:${owner} filename:package.json`, per_page: SEARCH_PAGE_SIZE, page },
				{ ignoreRateFloor: true }
			);
			hits.push(...res.items);
			if (res.incomplete_results) truncatedReason ??= "incomplete-search";
			if (res.items.length < SEARCH_PAGE_SIZE) break;
			if (hits.length < res.total_count && page === SEARCH_MAX_PAGES) truncatedReason ??= "max-results";
		}
		for (const h of hits) {
			if (h.path.split("/").pop() !== "package.json") continue;
			const key = h.repository.name;
			if (!byRepo.has(key)) byRepo.set(key, new Set());
			byRepo.get(key)!.add(h.path);
		}
		const repoNames = [...byRepo.keys()].sort((a, b) => a.localeCompare(b));
		scanned.candidates = repoNames.length;
		if (repoNames.length > maxRepos) truncatedReason ??= "max-repos";

		for (const repo of repoNames.slice(0, maxRepos)) {
			let info: RawRepo;
			try {
				info = await reqOne<RawRepo>(octokit, budget, "GET /repos/{owner}/{repo}", { owner, repo });
			} catch (err) {
				if ((err as { status?: number }).status !== 404) throw err;
				scanned.missing++;
				continue;
			}
			if (info.archived) {
				scanned.archived++;
				continue;
			}
			if (info.fork) {
				scanned.forks++;
				continue;
			}
			const ref: RepoRef = { name: repo, private: info.private ?? false, defaultBranch: info.default_branch };
			const entry = await scanBranch(ctx, ref, ref.defaultBranch, [...byRepo.get(repo)!]);
			if (!entry) {
				scanned.notDeclared++;
				continue;
			}
			await classify(entry, repo);
			dependents.push(entry);
		}

		if (devBranches) {
			const { repos, abandoned, complete } = await listDevBranches(octokit, budget, owner);
			abandonedDev.push(...abandoned);
			if (!complete) truncatedReason ??= "max-repos";
			const room = Math.max(0, maxRepos - Math.min(repoNames.length, maxRepos));
			if (repos.length > room) truncatedReason ??= "max-repos";
			for (const repo of repos.slice(0, room)) {
				const tree = await reqOne<RawTree>(octokit, budget, "GET /repos/{owner}/{repo}/git/trees/{tree_sha}", { owner, repo: repo.name, tree_sha: DEV_BRANCH, recursive: "1" });
				const paths = tree.tree
					.filter((t) => t.type === "blob" && t.path.split("/").pop() === "package.json" && !t.path.split("/").includes("node_modules"))
					.map((t) => t.path);
				scanned.devBranches!++;
				const entry = await scanBranch(ctx, repo, DEV_BRANCH, paths, tree.truncated ? [{ path: ".", reason: "tree-truncated" }] : []);
				if (!entry) continue;
				await classify(entry, repo.name);
				dependents.push(entry);
			}
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

	// One repo's default-branch entry sits directly before its dev entry.
	dependents.sort((a, b) => a.repo.localeCompare(b.repo) || Number(a.branch !== a.defaultBranch) - Number(b.branch !== b.defaultBranch));

	return {
		package: name,
		...(latest !== undefined ? { latest } : {}),
		...(latestError !== undefined ? { latestError } : {}),
		discovery: { source: "code-search", devBranches, note: SEARCH_NOTE + (devBranches ? DEV_NOTE : NO_DEV_NOTE) },
		scanned,
		dependents,
		...(abandonedDev.length > 0 ? { abandonedDev } : {}),
		...(truncatedReason ? { truncated: true, truncatedReason } : {}),
		...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {})
	};
}

/** JSON Schema advertised to the agent for report_dependents. */
export const REPORT_DEPENDENTS_SCHEMA = {
	type: "object" as const,
	required: ["owner", "name"],
	additionalProperties: false,
	properties: {
		owner: { type: "string", description: "repository owner (org/user login) — selects the read credential" },
		name: { type: "string", description: "npm package name to look for, e.g. @cldmv/fix-headers" },
		latest: { type: "boolean", description: "compare each resolved version with the latest published version and mark the ones that are behind", default: false },
		classify: { type: "boolean", description: "add each dependent repo's flow tier (v4 / dev-trunk / non-v4) and signals; about 3 REST calls per repo (default true)", default: true },
		devBranches: {
			type: "boolean",
			description:
				"also read every package.json on each repo's `dev` branch when it differs from the default branch, so dev-trunk repos are found; a dev whose root version is below the default branch's is skipped as abandoned (default true)",
			default: true
		},
		maxRepos: { type: "number", description: `safety cap on candidate repos verified (default ${DEFAULT_MAX_REPOS}, hard cap ${HARD_MAX_REPOS})` },
		maxFileBytes: { type: "number", description: `largest package.json or lockfile that is read, in bytes; bigger ones are listed in unread (default ${DEFAULT_MAX_FILE_BYTES}, hard cap ${HARD_MAX_FILE_BYTES})` },
		maxApiCalls: { type: "number", description: `hard ceiling on total REST calls this invocation makes (default ${DEFAULT_MAX_API_CALLS}, hard cap ${HARD_MAX_API_CALLS})` }
	}
};
