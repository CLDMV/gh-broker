/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/core/verbs/npm_scaffold.ts
 *	@Date: 2026-10-31T10:57:49-07:00 (1793469469)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-16T16:09:10-08:00 (1794874150)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import type { Octokit } from "@octokit/core";
import { NpmOtpRequired, type NpmRegistry } from "./npm-registry.ts";
import { buildTarball, tarballDigests } from "./npm-tarball.ts";

/**
 * Custom verb: npm_scaffold — create a new npm package and register its GitHub Actions
 * trusted publisher, so the repo's own publish workflow can release it from then on.
 *
 * Why it exists: npm only accepts a trusted publisher on a package that already exists, and
 * the first publish needs a human's 2FA. The broker holds a granular access token created
 * WITHOUT 2FA bypass (by the installer), and the user supplies a one-time password for each
 * call, which the agent passes through. The token alone can do nothing here.
 *
 * Guardrails, all checked before any npm write:
 *  - the package is under a scope listed in config.npm.scopes;
 *  - the repo belongs to the routed owner, is not archived, its package.json on the default
 *    branch names this package, and the publish workflow file exists there;
 *  - the package does not exist yet, or exists only as this verb's own placeholder (resume).
 *    An existing real package is refused, so the verb can never publish a version of one.
 *
 * The placeholder is built here from fixed fields (no agent-supplied files): a package.json
 * marked `scaffoldedBy: "gh-broker"` and a README pointing at the repo. Access follows the
 * repo's visibility (public repo → public package), the rule the CI publish also uses.
 *
 * Every npm write needs its own one-time password, so each call makes exactly one write:
 * the first call publishes the placeholder and returns `needs_otp` for the trusted
 * publisher; the second call (with the next code) adds it. A refused or expired code is
 * not an error either: the result is `needs_otp` naming what is left. npm stages a new
 * package's first publish and makes it live on its own shortly after; the call waits for that,
 * or for npm's own 0.0.0-stage (either means the package exists), and if neither shows in
 * time the result is `pending` (call again later with a fresh code).
 */

/**
 * The placeholder's version. A prerelease of 0.0.1 sorts below every real release and can't
 * take a real 0.0.1. It must not use the `-stage` suffix: npm's staged publishing reserves
 * `0.0.0-stage` for its own placeholder (a publish of it is refused with 403), and a PUT of
 * `0.0.1-stage` was answered 2xx but never went live (a retry got 409 "previously staged").
 */
export const PLACEHOLDER_VERSION = "0.0.1-placeholder";
export const SCAFFOLD_MARKER = "gh-broker";
/**
 * npm's own staged-publishing placeholder. Only npm can create it (a publish of it is refused),
 * and a staged first publish leaves it on the package next to ours once the stage goes live.
 */
export const NPM_STAGE_PLACEHOLDER = "0.0.0-stage";
/** Versions an earlier release of this verb may have published as its placeholder. */
const OUR_PLACEHOLDER = /^0\.0\.[01]-[a-z]+$/;
const DEFAULT_WORKFLOW = "publish.yml";
const INPUT_KEYS = new Set(["owner", "repo", "package", "npm_otp", "workflow", "path", "ref"]);
const DEFAULT_PATH = "package.json";
/** A repo-relative path to a file named package.json: plain segments, no "..", no leading "/". */
const PACKAGE_JSON_PATH = /^(?:[A-Za-z0-9_@-][A-Za-z0-9._@-]*\/)*package\.json$/;
/** A branch name: git's ref-name rules, narrowed to the characters CLDMV branches use. */
const BRANCH_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const PACKAGE_NAME = /^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/;

export interface NpmScaffoldInput {
	owner: string;
	repo: string;
	/** Scoped package name, e.g. "@cldmv/new-thing". */
	package: string;
	/**
	 * npm one-time password from the user's authenticator. Named npm_otp because `otp` is the
	 * broker's own gate code (src/otp/), which the router strips before the verb sees it.
	 */
	npm_otp: string;
	/** The repo's publish workflow file name. Defaults to publish.yml. */
	workflow?: string;
	/** Repo-relative path of the package.json that names the package. Defaults to "package.json". */
	path?: string;
	/** Branch to read the package.json and the workflow file from. Defaults to the repo's default branch. */
	ref?: string;
}

export const NPM_SCAFFOLD_SCHEMA = {
	type: "object" as const,
	properties: {
		owner: { type: "string", description: "Repository owner (a configured owner)." },
		repo: { type: "string", description: "Repository whose package.json names the package." },
		package: { type: "string", description: 'Scoped package name, e.g. "@cldmv/new-thing". Must be under a scope in config.npm.scopes.' },
		npm_otp: {
			type: "string",
			description:
				"npm one-time password the user read from their authenticator. Ask the user for it right before calling; codes expire in about 30 seconds."
		},
		workflow: { type: "string", description: 'The repo\'s publish workflow file in .github/workflows. Default "publish.yml".' },
		path: {
			type: "string",
			description:
				'Repo-relative path of the package.json that names the package, for a package that lives in a subfolder, e.g. "packaging/thing/package.json". Default "package.json".'
		},
		ref: {
			type: "string",
			description:
				'Branch to read that package.json and the workflow file from, e.g. "next" for a package not released to the default branch yet. Must be an existing branch. Default: the repo\'s default branch.'
		}
	},
	required: ["owner", "repo", "package", "npm_otp"],
	additionalProperties: false
};

export type NpmScaffoldStep = "publish" | "trust";

export interface NpmScaffoldResult {
	/**
	 * done: finished. needs_otp: call again with the next npm code. pending: npm accepted the
	 * first publish but is still making it live; call again with a fresh code in a minute.
	 * expired: the package's trusted publisher for this repo expired before any release used it;
	 * delete it on the package's access page and call again with a fresh code.
	 */
	status: "done" | "needs_otp" | "pending" | "expired";
	package: string;
	repository: string;
	workflow: string;
	access: "public" | "restricted";
	/** Steps this call completed. */
	done: NpmScaffoldStep[];
	/** Steps still to do: only set with needs_otp. */
	remaining?: NpmScaffoldStep[];
	/** Steps skipped because an earlier call already completed them. */
	skipped?: NpmScaffoldStep[];
	/** The placeholder version published; on a resumed call, the placeholder version(s) found on the registry, comma-separated. */
	version: string;
	url: string;
	trustId?: string;
	message: string;
}

export interface NpmScaffoldDeps {
	/** Read access to the repo (contents + metadata). */
	octokit: Octokit;
	registry: NpmRegistry;
	scopes: string[];
	/** How long to wait for a staged first publish to go live, and how often to look. */
	liveWaitMs?: number;
	livePollMs?: number;
	/** Injected for tests. */
	sleep?: (ms: number) => Promise<void>;
	/** The clock, for the trusted publisher's expiry check. Injected for tests. */
	now?: () => number;
}

/** npm made a staged first publish live about 77 s after answering 202; allow some margin. */
const LIVE_WAIT_MS = 120_000;
const LIVE_POLL_MS = 5_000;
const PENDING_MESSAGE =
	"npm accepted the placeholder publish, but the package isn't on the registry yet (npm stages a new package's first version and shows it on its own shortly after; nothing needs approving). Wait a minute, then call again with a fresh npm code to add the trusted publisher.";
/** The package exists on the registry once it shows our placeholder or npm's staging placeholder. */
const exists = (p: { versions?: Record<string, unknown> } | undefined) =>
	Boolean(p?.versions?.[PLACEHOLDER_VERSION] || p?.versions?.[NPM_STAGE_PLACEHOLDER]);

/**
 * npm expires a trusted publisher that has not published anything within 2 days of being
 * added. The expired entry stays listed but can't be used or edited, only deleted.
 */
const TRUST_UNUSED_LIFETIME_MS = 48 * 60 * 60 * 1000;
const TRUST_WINDOW_NOTE =
	"npm expires a trusted publisher that hasn't published within 2 days of being added, so merge the release that first publishes this package before then.";

/** The first of these keys holding a parseable timestamp, in ms. */
function timeField(c: Record<string, unknown>, keys: string[]): number | undefined {
	for (const k of keys) {
		const v = c[k];
		const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
		if (Number.isFinite(t)) return t;
	}
	return undefined;
}

/**
 * Whether npm's listing marks this configuration expired. npm does not document the trust
 * list's fields, so this reads every signal it might carry: an expired status or flag, an
 * expiry time in the past, or a creation time over 2 days ago (the verb only gets here while
 * the package holds placeholders alone, so no release has ever used the configuration).
 */
export function trustExpired(c: Record<string, unknown>, now: number): boolean {
	if (c.expired === true) return true;
	for (const k of ["status", "state"]) if (typeof c[k] === "string" && /expired/i.test(c[k] as string)) return true;
	const expires = timeField(c, ["expires_at", "expiresAt", "expires"]);
	if (expires !== undefined && expires <= now) return true;
	const created = timeField(c, ["created_at", "createdAt", "created"]);
	return created !== undefined && now - created >= TRUST_UNUSED_LIFETIME_MS;
}

const fail = (msg: string): never => {
	throw new Error(`npm_scaffold: ${msg}`);
};

type ValidInput = Required<Omit<NpmScaffoldInput, "ref">> & { ref?: string };

function validate(input: unknown): ValidInput {
	if (typeof input !== "object" || input === null || Array.isArray(input)) fail("arguments must be an object");
	const a = input as Record<string, unknown>;
	const unknown = Object.keys(a).filter((k) => !INPUT_KEYS.has(k));
	if (unknown.length) fail(`unknown argument(s): ${unknown.join(", ")} — expected ${[...INPUT_KEYS].join(", ")}`);
	if (typeof a.owner !== "string" || !/^[A-Za-z0-9-]+$/.test(a.owner)) fail('"owner" must be a GitHub owner name');
	if (typeof a.repo !== "string" || !/^[A-Za-z0-9._-]+$/.test(a.repo)) fail('"repo" must be a repository name');
	if (typeof a.package !== "string" || a.package.length > 214 || !PACKAGE_NAME.test(a.package))
		fail('"package" must be a lowercase scoped npm package name, e.g. "@cldmv/new-thing"');
	// Never echo the value: it is a live credential.
	if (typeof a.npm_otp !== "string" || !/^[0-9]{6,8}$/.test(a.npm_otp))
		fail('"npm_otp" must be the 6-8 digit npm code from the authenticator');
	if (a.workflow !== undefined && (typeof a.workflow !== "string" || !/^[A-Za-z0-9._-]+\.ya?ml$/.test(a.workflow))) {
		fail('"workflow" must be a workflow file name in .github/workflows, e.g. "publish.yml"');
	}
	if (
		a.path !== undefined &&
		(typeof a.path !== "string" ||
			a.path.length > 512 ||
			!PACKAGE_JSON_PATH.test(a.path) ||
			a.path.split("/").some((seg) => seg === ".." || seg === "."))
	) {
		fail('"path" must be a repo-relative path to a package.json, e.g. "packaging/thing/package.json" (no leading "/", no "..")');
	}
	if (
		a.ref !== undefined &&
		(typeof a.ref !== "string" ||
			a.ref.length > 255 ||
			!BRANCH_NAME.test(a.ref) ||
			a.ref.includes("..") ||
			a.ref.includes("//") ||
			a.ref.endsWith("/") ||
			a.ref.endsWith(".lock") ||
			a.ref.endsWith("."))
	) {
		fail('"ref" must be a branch name, e.g. "next"');
	}
	return {
		owner: a.owner as string,
		repo: a.repo as string,
		package: a.package as string,
		npm_otp: a.npm_otp as string,
		workflow: (a.workflow as string | undefined) ?? DEFAULT_WORKFLOW,
		path: (a.path as string | undefined) ?? DEFAULT_PATH,
		...(a.ref !== undefined ? { ref: a.ref as string } : {})
	};
}

function statusOf(err: unknown): number | undefined {
	return (err as { status?: number })?.status;
}

async function repoFile(octokit: Octokit, owner: string, repo: string, path: string, ref: string): Promise<string | undefined> {
	try {
		const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", { owner, repo, path, ref });
		const d = res.data as { content?: string; encoding?: string; type?: string };
		if (d.type !== "file" || typeof d.content !== "string") return undefined;
		return d.encoding === "base64" ? Buffer.from(d.content, "base64").toString("utf8") : d.content;
	} catch (err) {
		if (statusOf(err) === 404) return undefined;
		throw err;
	}
}

interface RepoFacts {
	repository: string;
	isPrivate: boolean;
	license?: string;
	description?: string;
}

async function branchExists(octokit: Octokit, owner: string, repo: string, branch: string): Promise<boolean> {
	try {
		await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", { owner, repo, branch });
		return true;
	} catch (err) {
		if (statusOf(err) === 404) return false;
		throw err;
	}
}

async function checkRepo(octokit: Octokit, args: ValidInput): Promise<RepoFacts & { ref: string }> {
	let info: { full_name?: string; private?: boolean; archived?: boolean; default_branch?: string };
	try {
		info = (await octokit.request("GET /repos/{owner}/{repo}", { owner: args.owner, repo: args.repo })).data as typeof info;
	} catch (err) {
		if (statusOf(err) === 404) fail(`repository ${args.owner}/${args.repo} not found`);
		throw err;
	}
	const asked = `${args.owner}/${args.repo}`;
	const repository = info.full_name ?? asked;
	// GitHub answers a renamed or transferred repo with a redirect, which the client follows.
	// The trusted publisher must name the repo that was routed and checked, so refuse that.
	if (repository.toLowerCase() !== asked.toLowerCase())
		fail(`${asked} redirects to ${repository} (renamed or transferred) — call with the repository's current owner and name`);
	if (info.archived) fail(`repository ${repository} is archived`);
	let ref = info.default_branch ?? "HEAD";
	if (args.ref !== undefined) {
		if (!(await branchExists(octokit, args.owner, args.repo, args.ref))) fail(`${repository} has no branch "${args.ref}"`);
		ref = args.ref;
	}
	const file = args.path;
	const raw = await repoFile(octokit, args.owner, args.repo, file, ref);
	if (raw === undefined) fail(`${repository} has no ${file} on ${ref}`);
	let pkg: { name?: unknown; license?: unknown; description?: unknown; private?: unknown };
	try {
		pkg = JSON.parse(raw as string) as typeof pkg;
	} catch {
		return fail(`${repository}'s ${file} on ${ref} is not valid JSON`);
	}
	if (pkg.name !== args.package) fail(`${repository}'s ${file} on ${ref} names ${JSON.stringify(pkg.name)}, not "${args.package}"`);
	if (pkg.private === true) fail(`${repository}'s ${file} on ${ref} is marked "private": true, so it is not meant to be published`);
	if ((await repoFile(octokit, args.owner, args.repo, `.github/workflows/${args.workflow}`, ref)) === undefined) {
		fail(`${repository} has no .github/workflows/${args.workflow} on ${ref} — the trusted publisher must name the workflow that publishes`);
	}
	return {
		repository,
		ref,
		isPrivate: info.private !== false,
		...(typeof pkg.license === "string" ? { license: pkg.license } : {}),
		...(typeof pkg.description === "string" ? { description: pkg.description } : {})
	};
}

/** The registry document for the placeholder's first publish (the shape libnpmpublish sends). */
export function placeholderDocument(name: string, facts: RepoFacts, access: "public" | "restricted", registry: string) {
	const repoUrl = `https://github.com/${facts.repository}`;
	const manifest = {
		name,
		version: PLACEHOLDER_VERSION,
		description: `Placeholder for ${name}. Releases are published from ${repoUrl} by CI.`,
		license: facts.license ?? "UNLICENSED",
		repository: { type: "git", url: `git+${repoUrl}.git` },
		homepage: `${repoUrl}#readme`,
		scaffoldedBy: SCAFFOLD_MARKER
	};
	const readme = `# ${name}\n\nThis version is a placeholder that reserves the package name so the repository's release workflow can publish it with npm trusted publishing.\n\n${facts.description ? `${facts.description}\n\n` : ""}Source and real releases: ${repoUrl}\n`;
	const tarball = buildTarball([
		{ path: "package.json", content: JSON.stringify(manifest, null, "\t") + "\n" },
		{ path: "README.md", content: readme }
	]);
	const { integrity, shasum } = tarballDigests(tarball);
	const tarballName = `${name}-${PLACEHOLDER_VERSION}.tgz`;
	const unscoped = name.split("/")[1]!;
	return {
		_id: name,
		name,
		description: manifest.description,
		"dist-tags": { latest: PLACEHOLDER_VERSION },
		access,
		versions: {
			[PLACEHOLDER_VERSION]: {
				...manifest,
				readme,
				_id: `${name}@${PLACEHOLDER_VERSION}`,
				dist: { integrity, shasum, tarball: `${registry}/${name}/-/${unscoped}-${PLACEHOLDER_VERSION}.tgz` }
			}
		},
		_attachments: { [tarballName]: { content_type: "application/octet-stream", data: tarball.toString("base64"), length: tarball.length } }
	};
}

export async function npmScaffold(input: unknown, deps: NpmScaffoldDeps): Promise<NpmScaffoldResult> {
	const args = validate(input);
	const scope = args.package.split("/")[0]!;
	if (!deps.scopes.includes(scope)) fail(`scope ${scope} is not in config.npm.scopes (${deps.scopes.join(", ")})`);

	const facts = await checkRepo(deps.octokit, args);
	const access = facts.isPrivate ? "restricted" : "public";
	const base = {
		package: args.package,
		repository: facts.repository,
		workflow: args.workflow,
		access,
		version: PLACEHOLDER_VERSION,
		url: `https://www.npmjs.com/package/${args.package}`
	} as const;

	const existing = await deps.registry.packument(args.package);
	if (!existing) {
		let answer: { status: number; detail: string };
		try {
			answer = await deps.registry.publish(
				placeholderDocument(args.package, facts, access, deps.registry.registry),
				args.package,
				args.npm_otp
			);
		} catch (err) {
			if (err instanceof NpmOtpRequired) {
				return {
					...base,
					status: "needs_otp",
					done: [],
					remaining: ["publish", "trust"],
					message: "npm refused the one-time password before publishing; nothing was written. Call again with a fresh code."
				};
			}
			throw err;
		}
		// Only call it published once the package is on the registry. npm stages a new package's
		// first publish: it answers 202, creates the package with its own 0.0.0-stage, and makes
		// our version live on its own a minute or so later. Either version means the package
		// exists, so the trusted publisher can be added; wait until one of them shows.
		const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
		const waitMs = deps.liveWaitMs ?? LIVE_WAIT_MS;
		const pollMs = deps.livePollMs ?? LIVE_POLL_MS;
		let live = await deps.registry.packument(args.package);
		for (let waited = 0; !exists(live) && waited < waitMs; waited += pollMs) {
			await sleep(pollMs);
			live = await deps.registry.packument(args.package);
		}
		if (!exists(live)) {
			// The publish was accepted (2xx) and the code is spent, so this is not an error: a
			// later call finds the placeholder and goes on to the trusted publisher.
			return {
				...base,
				status: "pending",
				done: ["publish"],
				remaining: ["trust"],
				message: `${PENDING_MESSAGE} (npm answered HTTP ${answer.status}${answer.detail ? `: ${answer.detail}` : ""}.)`
			};
		}
		// That code is spent: every npm write needs its own one-time password, so don't
		// send it again (a guaranteed refusal that counts as a failed 2FA attempt).
		return {
			...base,
			status: "needs_otp",
			done: ["publish"],
			remaining: ["trust"],
			message:
				"The placeholder is published. Each npm write needs its own one-time password: call again with the next code (wait for the authenticator to change) to add the trusted publisher."
		};
	}

	// The package exists: carry on only if it is this verb's own placeholder (a resumed call).
	// Every version must be one of our marked placeholders or npm's own staging placeholder.
	// npm's 0.0.0-stage alone counts too: it is what a staged first publish shows before our
	// version goes live, and the package already exists then, so the trust step can run (no
	// second placeholder is ever written). It records no repository, so only the scope and
	// repo checks above guard that case.
	const entries = Object.entries(existing.versions ?? {});
	const placeholders = entries.filter(([v, doc]) => OUR_PLACEHOLDER.test(v) && doc?.scaffoldedBy === SCAFFOLD_MARKER).map(([, doc]) => doc);
	const ours = entries.length > 0 && entries.length === placeholders.length + (existing.versions?.[NPM_STAGE_PLACEHOLDER] ? 1 : 0);
	if (!ours)
		fail(
			`${args.package} already exists on the registry (${entries.length} version(s)) and was not created by npm_scaffold — set up its trusted publisher on npmjs.com instead`
		);
	// Each placeholder records the repo it was made for; the trusted publisher may only go there.
	for (const placeholder of placeholders) {
		const madeFor = (placeholder.repository as { url?: unknown } | undefined)?.url;
		if (typeof madeFor !== "string" || madeFor.toLowerCase() !== `git+https://github.com/${facts.repository}.git`.toLowerCase()) {
			fail(
				`${args.package}'s placeholder was published for ${typeof madeFor === "string" ? madeFor : "an unrecorded repository"}, not ${facts.repository}`
			);
		}
	}

	// A resumed call reports the placeholder version(s) actually on the registry (e.g.
	// "0.0.0-stage, 0.0.1-stage"), not this release's PLACEHOLDER_VERSION constant.
	const resumed = {
		...base,
		version: entries
			.map(([v]) => v)
			.sort()
			.join(", ")
	};

	let out: Awaited<ReturnType<NpmRegistry["addGithubTrust"]>>;
	try {
		out = await deps.registry.addGithubTrust(args.package, { repository: facts.repository, file: args.workflow }, args.npm_otp);
	} catch (err) {
		if (err instanceof NpmOtpRequired) {
			return {
				...resumed,
				status: "needs_otp",
				done: [],
				remaining: ["trust"],
				skipped: ["publish"],
				message:
					"The placeholder is published, but npm refused the one-time password for the trusted publisher (expired or already used). Call again with a new code to finish."
			};
		}
		throw err;
	}

	let alreadyThere = false;
	if (out.conflict) {
		// npm already has a trusted publisher for this package. Only call it done if it is the
		// one asked for. The code was spent on the POST, so the list may need another one.
		const access = `https://www.npmjs.com/package/${args.package}/access`;
		let configs: Awaited<ReturnType<NpmRegistry["listTrust"]>>;
		try {
			configs = await deps.registry.listTrust(args.package);
		} catch (err) {
			if (err instanceof NpmOtpRequired)
				fail(
					`${args.package} already has a trusted publisher, and npm needs another one-time password to show which; check it at ${access}`
				);
			throw err;
		}
		const claimsOf = (c: Record<string, unknown>) => (c.claims ?? {}) as { repository?: unknown; workflow_ref?: { file?: unknown } };
		const matches = configs.find((c) => {
			const cl = claimsOf(c);
			return (
				c.type === "github" &&
				typeof cl.repository === "string" &&
				cl.repository.toLowerCase() === facts.repository.toLowerCase() &&
				cl.workflow_ref?.file === args.workflow
			);
		});
		if (!matches) {
			const existingList =
				configs.map((c) => `${String(c.type)} ${String(claimsOf(c).repository)} (${String(claimsOf(c).workflow_ref?.file)})`).join("; ") ||
				"unreadable";
			fail(`${args.package} already has a different trusted publisher: ${existingList}. Change it at ${access}`);
		}
		// fail() above never returns, so matches is set here.
		const found = matches as Record<string, unknown>;
		if (trustExpired(found, (deps.now ?? Date.now)())) {
			return {
				...resumed,
				status: "expired",
				done: [],
				remaining: ["trust"],
				skipped: ["publish"],
				...(typeof found.id === "string" ? { trustId: found.id } : {}),
				message: `${args.package}'s trusted publisher for ${facts.repository} (.github/workflows/${args.workflow}) expired: npm drops one that hasn't published within 2 days of being added, and an expired one can only be deleted. Delete it at ${access}, then call again with a fresh npm code close to the release that first publishes the package.`
			};
		}
		alreadyThere = true;
		out = { config: matches, conflict: true };
	}

	const trustId = typeof out.config?.id === "string" ? out.config.id : undefined;
	return {
		...resumed,
		status: "done",
		done: alreadyThere ? [] : ["trust"],
		skipped: alreadyThere ? ["publish", "trust"] : ["publish"],
		...(trustId ? { trustId } : {}),
		message: `${args.package} exists with a trusted publisher for ${facts.repository} (.github/workflows/${args.workflow}); its next release can publish through OIDC. ${alreadyThere ? `No release has used it yet: ${TRUST_WINDOW_NOTE} Check https://www.npmjs.com/package/${args.package}/access shows it as valid.` : TRUST_WINDOW_NOTE}`
	};
}
