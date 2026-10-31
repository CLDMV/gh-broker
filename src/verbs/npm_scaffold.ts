/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/npm_scaffold.ts
 *	@Date: 2026-10-31T10:57:49-07:00 (1793469469)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-31T12:58:19-07:00 (1793476699)
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
 * not an error either: the result is `needs_otp` naming what is left.
 */

export const PLACEHOLDER_VERSION = "0.0.0-stage";
export const SCAFFOLD_MARKER = "gh-broker";
const DEFAULT_WORKFLOW = "publish.yml";
const INPUT_KEYS = new Set(["owner", "repo", "package", "otp", "workflow"]);
const PACKAGE_NAME = /^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/;

export interface NpmScaffoldInput {
	owner: string;
	repo: string;
	/** Scoped package name, e.g. "@cldmv/new-thing". */
	package: string;
	/** One-time password from the user's authenticator. */
	otp: string;
	/** The repo's publish workflow file name. Defaults to publish.yml. */
	workflow?: string;
}

export const NPM_SCAFFOLD_SCHEMA = {
	type: "object" as const,
	properties: {
		owner: { type: "string", description: "Repository owner (a configured owner)." },
		repo: { type: "string", description: "Repository whose package.json names the package." },
		package: { type: "string", description: 'Scoped package name, e.g. "@cldmv/new-thing". Must be under a scope in config.npm.scopes.' },
		otp: { type: "string", description: "One-time password the user read from their authenticator. Ask the user for it right before calling; codes expire in about 30 seconds." },
		workflow: { type: "string", description: 'The repo\'s publish workflow file in .github/workflows. Default "publish.yml".' }
	},
	required: ["owner", "repo", "package", "otp"],
	additionalProperties: false
};

export type NpmScaffoldStep = "publish" | "trust";

export interface NpmScaffoldResult {
	status: "done" | "needs_otp";
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
}

const fail = (msg: string): never => {
	throw new Error(`npm_scaffold: ${msg}`);
};

function validate(input: unknown): Required<NpmScaffoldInput> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) fail("arguments must be an object");
	const a = input as Record<string, unknown>;
	const unknown = Object.keys(a).filter((k) => !INPUT_KEYS.has(k));
	if (unknown.length) fail(`unknown argument(s): ${unknown.join(", ")} — expected ${[...INPUT_KEYS].join(", ")}`);
	if (typeof a.owner !== "string" || !/^[A-Za-z0-9-]+$/.test(a.owner)) fail('"owner" must be a GitHub owner name');
	if (typeof a.repo !== "string" || !/^[A-Za-z0-9._-]+$/.test(a.repo)) fail('"repo" must be a repository name');
	if (typeof a.package !== "string" || a.package.length > 214 || !PACKAGE_NAME.test(a.package)) fail('"package" must be a lowercase scoped npm package name, e.g. "@cldmv/new-thing"');
	// Never echo the value: it is a live credential.
	if (typeof a.otp !== "string" || !/^[0-9]{6,8}$/.test(a.otp)) fail('"otp" must be the 6-8 digit code from the authenticator');
	if (a.workflow !== undefined && (typeof a.workflow !== "string" || !/^[A-Za-z0-9._-]+\.ya?ml$/.test(a.workflow))) {
		fail('"workflow" must be a workflow file name in .github/workflows, e.g. "publish.yml"');
	}
	return {
		owner: a.owner as string,
		repo: a.repo as string,
		package: a.package as string,
		otp: a.otp as string,
		workflow: (a.workflow as string | undefined) ?? DEFAULT_WORKFLOW
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

async function checkRepo(octokit: Octokit, args: Required<NpmScaffoldInput>): Promise<RepoFacts> {
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
	if (repository.toLowerCase() !== asked.toLowerCase()) fail(`${asked} redirects to ${repository} (renamed or transferred) — call with the repository's current owner and name`);
	if (info.archived) fail(`repository ${repository} is archived`);
	const ref = info.default_branch ?? "HEAD";
	const raw = await repoFile(octokit, args.owner, args.repo, "package.json", ref);
	if (raw === undefined) fail(`${repository} has no package.json on ${ref}`);
	let pkg: { name?: unknown; license?: unknown; description?: unknown; private?: unknown };
	try {
		pkg = JSON.parse(raw as string) as typeof pkg;
	} catch {
		return fail(`${repository}'s package.json on ${ref} is not valid JSON`);
	}
	if (pkg.name !== args.package) fail(`${repository}'s package.json on ${ref} names ${JSON.stringify(pkg.name)}, not "${args.package}"`);
	if (pkg.private === true) fail(`${repository}'s package.json is marked "private": true, so it is not meant to be published`);
	if ((await repoFile(octokit, args.owner, args.repo, `.github/workflows/${args.workflow}`, ref)) === undefined) {
		fail(`${repository} has no .github/workflows/${args.workflow} on ${ref} — the trusted publisher must name the workflow that publishes`);
	}
	return {
		repository,
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
		try {
			await deps.registry.publish(placeholderDocument(args.package, facts, access, deps.registry.registry), args.package, args.otp);
		} catch (err) {
			if (err instanceof NpmOtpRequired) {
				return { ...base, status: "needs_otp", done: [], remaining: ["publish", "trust"], message: "npm refused the one-time password before publishing; nothing was written. Call again with a fresh code." };
			}
			throw err;
		}
		// That code is spent: every npm write needs its own one-time password, so don't
		// send it again (a guaranteed refusal that counts as a failed 2FA attempt).
		return {
			...base,
			status: "needs_otp",
			done: ["publish"],
			remaining: ["trust"],
			message: "The placeholder is published. Each npm write needs its own one-time password: call again with the next code (wait for the authenticator to change) to add the trusted publisher."
		};
	}

	// The package exists: carry on only if it is this verb's own placeholder (a resumed call).
	const versions = Object.keys(existing.versions ?? {});
	const placeholder = existing.versions?.[PLACEHOLDER_VERSION];
	const ours = versions.length === 1 && versions[0] === PLACEHOLDER_VERSION && placeholder?.scaffoldedBy === SCAFFOLD_MARKER;
	if (!ours) fail(`${args.package} already exists on the registry (${versions.length} version(s)) and was not created by npm_scaffold — set up its trusted publisher on npmjs.com instead`);
	// The placeholder records the repo it was made for; the trusted publisher may only go there.
	const madeFor = (placeholder?.repository as { url?: unknown } | undefined)?.url;
	if (typeof madeFor !== "string" || madeFor.toLowerCase() !== `git+https://github.com/${facts.repository}.git`.toLowerCase()) {
		fail(`${args.package}'s placeholder was published for ${typeof madeFor === "string" ? madeFor : "an unrecorded repository"}, not ${facts.repository}`);
	}

	let out: Awaited<ReturnType<NpmRegistry["addGithubTrust"]>>;
	try {
		out = await deps.registry.addGithubTrust(args.package, { repository: facts.repository, file: args.workflow }, args.otp);
	} catch (err) {
		if (err instanceof NpmOtpRequired) {
			return {
				...base,
				status: "needs_otp",
				done: [],
				remaining: ["trust"],
				skipped: ["publish"],
				message: "The placeholder is published, but npm refused the one-time password for the trusted publisher (expired or already used). Call again with a new code to finish."
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
			if (err instanceof NpmOtpRequired) fail(`${args.package} already has a trusted publisher, and npm needs another one-time password to show which; check it at ${access}`);
			throw err;
		}
		const claimsOf = (c: Record<string, unknown>) => (c.claims ?? {}) as { repository?: unknown; workflow_ref?: { file?: unknown } };
		const matches = configs.find((c) => {
			const cl = claimsOf(c);
			return c.type === "github" && typeof cl.repository === "string" && cl.repository.toLowerCase() === facts.repository.toLowerCase() && cl.workflow_ref?.file === args.workflow;
		});
		if (!matches) {
			const existingList = configs.map((c) => `${String(c.type)} ${String(claimsOf(c).repository)} (${String(claimsOf(c).workflow_ref?.file)})`).join("; ") || "unreadable";
			fail(`${args.package} already has a different trusted publisher: ${existingList}. Change it at ${access}`);
		}
		alreadyThere = true;
		out = { config: matches, conflict: true };
	}

	const trustId = typeof out.config?.id === "string" ? out.config.id : undefined;
	return {
		...base,
		status: "done",
		done: alreadyThere ? [] : ["trust"],
		skipped: alreadyThere ? ["publish", "trust"] : ["publish"],
		...(trustId ? { trustId } : {}),
		message: `${args.package} exists with a trusted publisher for ${facts.repository} (.github/workflows/${args.workflow}); its next release can publish through OIDC.`
	};
}
