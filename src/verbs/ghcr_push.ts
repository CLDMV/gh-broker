/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/ghcr_push.ts
 *	@Date: 2026-10-31T11:02:57-07:00 (1793469777)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T09:58:22-08:00 (1794679102)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Custom verbs: ghcr_push, ghcr_push_status, ghcr_tags — push container images to GHCR
 * (ghcr.io/<owner>/<image>) without the agent ever holding a registry credential.
 *
 * The agent writes a `docker save` archive into the drop directory and calls `ghcr_push`.
 * The broker checks the call against `config.ghcr` (owner configured, image on the owner's
 * allowlist, tag well-formed, archive really inside the drop directory, release tag not
 * already taken), exchanges the owner's classic PAT for a registry token, and pushes in a
 * background job. `ghcr_push_status` reports that job; `ghcr_tags` lists an allowlisted
 * image's tags so a push can be verified.
 *
 * What the verbs can't do, by construction: talk to any registry but ghcr.io, push outside
 * `ghcr.io/<owner>/<allowlisted image>`, delete anything, change visibility, or read a
 * file outside the drop directory. No result, error, audit line or log line carries the
 * PAT or the registry token (registry.ts `clean()`).
 *
 * The handlers are the real contract: the MCP server doesn't validate against the
 * advertised schemas, so every key and type is checked here before any network call.
 */

import type { SecretStore } from "../types.ts";
import { audit } from "../audit.ts";
import { imageAllowed, type GhcrConfig, type GhcrOwnerConfig } from "./ghcr/config.ts";
import { openArchive, planImage } from "./ghcr/archive.ts";
import { Registry, GHCR_BASE } from "./ghcr/registry.ts";
import { pushImage, RELEASE_TAG } from "./ghcr/push.ts";
import { JobQueue, type Job } from "./ghcr/jobs.ts";

/** OCI repository path component; `/` separates components. */
const IMAGE = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/;
/** OCI tag grammar. */
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PUSH_KEYS = new Set(["owner", "image", "tag", "archive"]);
const STATUS_KEYS = new Set(["owner", "job"]);
const TAGS_KEYS = new Set(["owner", "image"]);

export interface GhcrPushInput {
	owner: string;
	image: string;
	tag: string;
	archive: string;
}
export interface GhcrPushStatusInput {
	owner: string;
	job?: string;
}
export interface GhcrTagsInput {
	owner: string;
	image: string;
}

function strictArgs(verb: string, input: unknown, keys: Set<string>): Record<string, unknown> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error(`${verb}: arguments must be an object`);
	const a = input as Record<string, unknown>;
	const unknown = Object.keys(a).filter((k) => !keys.has(k));
	if (unknown.length) throw new Error(`${verb}: unknown argument(s): ${unknown.join(", ")} — expected ${[...keys].join(", ")}`);
	if (typeof a.owner !== "string" || !a.owner.trim()) throw new Error(`${verb}: "owner" must be a non-empty string`);
	return a;
}

export interface GhcrServiceOptions {
	/** Registry origin — tests only; production is always https://ghcr.io. */
	base?: string;
	queue?: JobQueue;
}

export class GhcrService {
	private readonly cfg?: GhcrConfig;
	private readonly secrets: SecretStore;
	private readonly base: string;
	readonly queue: JobQueue;

	constructor(cfg: GhcrConfig | undefined, secrets: SecretStore, opts: GhcrServiceOptions = {}) {
		this.cfg = cfg;
		this.secrets = secrets;
		this.base = opts.base ?? GHCR_BASE;
		this.queue = opts.queue ?? new JobQueue();
	}

	private config(verb: string): GhcrConfig {
		if (!this.cfg) throw new Error(`${verb}: GHCR is not configured — add a "ghcr" block to the config (see docs/TOOLS.md#ghcr_push)`);
		return this.cfg;
	}

	private ownerConfig(verb: string, owner: string): GhcrOwnerConfig {
		const o = this.config(verb).owners[owner.toLowerCase()];
		if (!o) throw new Error(`${verb}: owner "${owner}" has no GHCR configuration (config.ghcr.owners)`);
		if (!this.secrets.has(o.credential)) throw new Error(`${verb}: owner "${owner}"'s GHCR credential "${o.credential.replace(/^cred:/, "")}" is not stored (re-run the installer to add it)`);
		return o;
	}

	private image(verb: string, owner: string, oc: GhcrOwnerConfig, raw: unknown): string {
		if (typeof raw !== "string" || !raw) throw new Error(`${verb}: "image" must be a non-empty string`);
		const lower = raw.toLowerCase();
		if (lower.startsWith("ghcr.io/") || lower.startsWith(`${owner}/`)) {
			throw new Error(`${verb}: "image" is the name under ghcr.io/${owner}/ — pass e.g. "hoot", not "${raw}"`);
		}
		if (!IMAGE.test(raw) || raw.length + owner.length + 1 > 255) throw new Error(`${verb}: "image" "${raw}" is not a valid image name (lowercase [a-z0-9], separators . _ __ -, "/" between segments)`);
		if (!imageAllowed(oc, raw)) throw new Error(`${verb}: ghcr.io/${owner}/${raw} is not on the allowlist (config.ghcr.owners.${owner}.images: ${oc.images.join(", ")})`);
		return raw;
	}

	private registry(owner: string, oc: GhcrOwnerConfig, image: string): Registry {
		return new Registry({ base: this.base, username: oc.username, password: this.secrets.resolve(oc.credential), repository: `${owner}/${image}` });
	}

	async push(input: unknown): Promise<Omit<Job, "progress" | "result">> {
		const verb = "ghcr_push";
		const a = strictArgs(verb, input, PUSH_KEYS);
		const owner = (a.owner as string).toLowerCase();
		const cfg = this.config(verb);
		const oc = this.ownerConfig(verb, owner);
		const image = this.image(verb, owner, oc, a.image);
		if (typeof a.tag !== "string" || !TAG.test(a.tag)) throw new Error(`${verb}: "tag" must be a valid tag ([A-Za-z0-9_][A-Za-z0-9._-]{0,127})`);
		const tag = a.tag;

		const archive = openArchive(a.archive, cfg.dropDir, cfg.maxArchiveBytes);
		let handedOff = false;
		let registry: Registry | undefined;
		try {
			const plan = planImage(archive.fd, archive.size);
			registry = this.registry(owner, oc, image);
			const ref = `${registry.host}/${owner}/${image}`;
			// First network calls: proves the credential can push here, and refuses a taken release tag
			// before the job is queued (push.ts re-checks right before the manifest PUT).
			await registry.login("push,pull");
			if (cfg.protectReleaseTags && RELEASE_TAG.test(tag) && (await registry.manifestExists(tag))) {
				throw new Error(`${verb}: tag ${tag} already exists on ${ref} and release tags are protected — push a new version instead`);
			}

			const reg = registry;
			const job = this.queue.submit(
				{ owner, image: ref, tag, archive: archive.path, archiveBytes: archive.size, format: plan.format },
				{
					run: (progress) => pushImage(reg, archive.fd, plan, tag, { protectReleaseTags: cfg.protectReleaseTags, onProgress: progress }),
					describeError: (err) => reg.clean((err as Error)?.message ?? String(err)),
					finally: (done) => {
						archive.close();
						audit({
							tool: verb,
							owner,
							mode: "write",
							repo: ref,
							decision: "custom",
							ok: done.state === "succeeded",
							detail:
								done.state === "succeeded"
									? `job=${done.job} tag=${tag} digest=${done.result?.digest} size=${done.result?.size} uploaded=${done.result?.blobsUploaded} skipped=${done.result?.blobsSkipped} archive=${archive.path}`
									: `job=${done.job} tag=${tag} archive=${archive.path} error=${done.error}`
						});
					}
				}
			);
			handedOff = true;
			audit({ tool: verb, owner, mode: "write", repo: ref, decision: "custom", ok: true, detail: `job=${job.job} queued tag=${tag} archive=${archive.path} bytes=${archive.size} format=${plan.format} layers=${plan.layers.length}` });
			return { ...job };
		} catch (err) {
			// Anything thrown before hand-off may come from the registry: scrub it like a job error.
			if (!registry) throw err; // archive/plan errors carry no secret
			throw new Error(registry.clean((err as Error)?.message ?? String(err)));
		} finally {
			if (!handedOff) archive.close();
		}
	}

	status(input: unknown): Job | { jobs: Job[] } {
		const verb = "ghcr_push_status";
		const a = strictArgs(verb, input, STATUS_KEYS);
		const owner = (a.owner as string).toLowerCase();
		this.ownerConfig(verb, owner);
		if (a.job === undefined) return { jobs: this.queue.list(owner) };
		if (typeof a.job !== "string" || !JOB_ID.test(a.job)) throw new Error(`${verb}: "job" must be a job id returned by ghcr_push`);
		const job = this.queue.get(a.job);
		// A job of another owner reads as unknown: status never crosses owners.
		if (!job || job.owner !== owner) throw new Error(`${verb}: no job ${a.job} for owner ${owner} (jobs are kept in memory; a broker restart forgets them)`);
		return job;
	}

	async tags(input: unknown): Promise<{ image: string; exists: boolean; tags: string[] }> {
		const verb = "ghcr_tags";
		const a = strictArgs(verb, input, TAGS_KEYS);
		const owner = (a.owner as string).toLowerCase();
		const oc = this.ownerConfig(verb, owner);
		const image = this.image(verb, owner, oc, a.image);
		const registry = this.registry(owner, oc, image);
		try {
			await registry.login("pull");
			const tags = await registry.listTags();
			return { image: `${registry.host}/${owner}/${image}`, exists: tags !== undefined, tags: tags ?? [] };
		} catch (err) {
			throw new Error(registry.clean((err as Error)?.message ?? String(err)));
		}
	}
}

// The schemas + descriptions are pure data in ./ghcr/schemas.ts so the tool manifest can
// declare these verbs without dragging this file's host imports into its graph; they are
// re-exported here so the old import path keeps working.
import {
	GHCR_PUSH_SCHEMA,
	GHCR_PUSH_STATUS_SCHEMA,
	GHCR_TAGS_SCHEMA
} from "./ghcr/schemas.ts";
export { GHCR_PUSH_SCHEMA, GHCR_PUSH_STATUS_SCHEMA, GHCR_TAGS_SCHEMA };
