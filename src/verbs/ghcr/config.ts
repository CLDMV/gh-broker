/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/ghcr/config.ts
 *	@Date: 2026-10-31T10:57:30-07:00 (1793469450)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T00:40:55-07:00 (1793518855)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Config block for the GHCR verbs (`ghcr_push`, `ghcr_push_status`, `ghcr_tags`).
 *
 * GHCR is a separate credential and a separate policy from the GitHub API routing in
 * `config.owners`: the registry does not accept fine-grained PATs, so it needs a classic
 * PAT with `write:packages`, and that token must only ever reach `ghcr.io`. Keeping it in
 * its own block (rather than a third ref on `owners.<o>`) keeps the existing owner
 * credentials untouched and lets the installer treat the whole block as operator data, set with
 * `--ghcr-*` flags or a `--config` file (see deploy/lib/config-merge.mjs).
 *
 *   "ghcr": {
 *     "dropDir": "/srv/gh-broker/ghcr-drop",
 *     "protectReleaseTags": true,
 *     "owners": {
 *       "your-org": { "username": "your-login", "credential": "cred:your-org-packages", "images": ["your-image", "your-image-worker-*"] }
 *     }
 *   }
 *
 * Every key is checked strictly (unknown keys are refused) because this is a security
 * policy: a typo such as `image` for `images` must fail loudly, not silently allow nothing
 * or everything.
 */

import { isAbsolute, normalize } from "node:path";

export interface GhcrOwnerConfig {
	/** GitHub login the classic PAT belongs to; sent as the Basic-auth user to ghcr.io/token. */
	username: string;
	/** "cred:<name>" ref for the classic PAT (write:packages). */
	credential: string;
	/** Image names under ghcr.io/<owner>/ that may be pushed or listed. `*` matches within one path segment. */
	images: string[];
}

export interface GhcrConfig {
	/** The only directory archives are read from. Absolute; the installer creates it. */
	dropDir: string;
	/** Refuse to overwrite an existing tag shaped like a release (`1.2.3` / `v1.2.3`). */
	protectReleaseTags: boolean;
	/** Largest archive accepted, in bytes. */
	maxArchiveBytes: number;
	owners: Record<string, GhcrOwnerConfig>;
}

export const DEFAULT_MAX_ARCHIVE_BYTES = 16 * 1024 ** 3;
const TOP_KEYS = new Set(["dropDir", "protectReleaseTags", "maxArchiveBytes", "owners"]);
const OWNER_KEYS = new Set(["username", "credential", "images"]);
/** Directories that must never be a drop dir: system state, other users' homes, secrets. */
const FORBIDDEN_ROOTS = ["/etc", "/proc", "/sys", "/dev", "/run", "/boot", "/root", "/home", "/tmp", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/var/tmp"];
/** One image-name glob: lowercase OCI path components, `*` allowed, `/` separates segments. */
const IMAGE_GLOB = /^[a-z0-9*](?:[a-z0-9._*-]*[a-z0-9*])?(?:\/[a-z0-9*](?:[a-z0-9._*-]*[a-z0-9*])?)*$/;
const OWNER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;

const fail = (msg: string): never => {
	throw new Error(`config.ghcr${msg}`);
};

function strictKeys(o: Record<string, unknown>, allowed: Set<string>, where: string): void {
	const extra = Object.keys(o).filter((k) => !allowed.has(k));
	if (extra.length) fail(`${where}: unknown key(s) ${extra.join(", ")} — expected ${[...allowed].join(", ")}`);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseGhcrConfig(raw: unknown): GhcrConfig {
	if (!isObject(raw)) return fail(": must be an object");
	strictKeys(raw, TOP_KEYS, "");

	const dropDir = raw.dropDir;
	if (typeof dropDir !== "string" || !isAbsolute(dropDir)) fail('.dropDir: must be an absolute path, e.g. "/srv/gh-broker/ghcr-drop"');
	const dir = normalize(dropDir as string).replace(/\/+$/, "");
	if (!dir || dir !== (dropDir as string).replace(/\/+$/, "")) fail(".dropDir: must be a normalized path (no ., .. or doubled slashes)");
	if (dir.split("/").filter(Boolean).length < 2) fail(".dropDir: must be at least two levels deep, e.g. /srv/gh-broker/ghcr-drop");
	for (const root of FORBIDDEN_ROOTS) {
		if (dir === root || dir.startsWith(`${root}/`)) fail(`.dropDir: may not be under ${root}`);
	}

	if (raw.protectReleaseTags !== undefined && typeof raw.protectReleaseTags !== "boolean") fail(".protectReleaseTags: must be a boolean");
	let maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES;
	if (raw.maxArchiveBytes !== undefined) {
		const m = raw.maxArchiveBytes;
		if (typeof m !== "number" || !Number.isSafeInteger(m) || m <= 0) fail(".maxArchiveBytes: must be a positive integer");
		maxArchiveBytes = m as number;
	}

	if (!isObject(raw.owners) || Object.keys(raw.owners).length === 0) fail(".owners: must be an object with at least one owner");
	const owners: Record<string, GhcrOwnerConfig> = {};
	for (const [name, v] of Object.entries(raw.owners as Record<string, unknown>)) {
		const owner = name.toLowerCase();
		if (!OWNER_NAME.test(owner)) fail(`.owners: "${name}" is not a valid GitHub owner name`);
		if (!isObject(v)) fail(`.owners.${name}: must be an object`);
		const o = v as Record<string, unknown>;
		strictKeys(o, OWNER_KEYS, `.owners.${name}`);
		if (typeof o.username !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(o.username)) fail(`.owners.${name}.username: must be the GitHub login that owns the PAT`);
		if (typeof o.credential !== "string" || !/^cred:[A-Za-z0-9._-]+$/.test(o.credential) || /^cred:\.\.?$/.test(o.credential)) {
			fail(`.owners.${name}.credential: must be a "cred:<name>" ref`);
		}
		if (!Array.isArray(o.images) || o.images.length === 0) fail(`.owners.${name}.images: must be a non-empty list of image names or globs`);
		for (const img of o.images as unknown[]) {
			if (typeof img !== "string" || img.length > 255 || !IMAGE_GLOB.test(img)) {
				fail(`.owners.${name}.images: "${String(img)}" is not a valid image name or glob (lowercase, [a-z0-9._-], "/" between segments, "*" within a segment)`);
			}
		}
		owners[owner] = { username: o.username as string, credential: o.credential as string, images: [...(o.images as string[])] };
	}

	return { dropDir: dir, protectReleaseTags: raw.protectReleaseTags !== false, maxArchiveBytes, owners };
}

/** Every "cred:<name>" ref the ghcr block references, for eager validation at startup. */
export function ghcrCredRefs(cfg: GhcrConfig | undefined): string[] {
	return cfg ? Object.values(cfg.owners).map((o) => o.credential) : [];
}

/** Compile an image glob to an anchored regex: `*` matches `[a-z0-9._-]*` (never `/`). */
export function imageGlobToRegExp(glob: string): RegExp {
	const body = glob
		.split("*")
		.map((part) => part.replace(/[.\\^$+?()[\]{}|-]/g, "\\$&"))
		.join("[a-z0-9._-]*");
	return new RegExp(`^${body}$`);
}

/** True when `image` (a name under the owner, e.g. "hoot-worker-a") is on the owner's allowlist. */
export function imageAllowed(owner: GhcrOwnerConfig, image: string): boolean {
	return owner.images.some((g) => imageGlobToRegExp(g).test(image));
}
