/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/ghcr/schemas.ts
 *	@Date: 2026-11-14T00:00:00-08:00 (1794643200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T09:06:07-08:00 (1794675967)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The GHCR verbs' advertised descriptions and input schemas, as pure data. They live
 * apart from the GhcrService (src/verbs/ghcr_push.ts) so the tool manifest
 * (src/manifest.ts) can declare the verbs without dragging the service's host imports
 * (the audit sink, the archive reader, the registry client) into its graph.
 */

const owner = { type: "string", description: "registry owner (org/user login) — must be configured in config.ghcr.owners" };
const image = { type: "string", description: 'image name under ghcr.io/<owner>/, e.g. "hoot" — must match config.ghcr.owners.<owner>.images' };

export const GHCR_PUSH_DESCRIPTION =
	"Push a container image to ghcr.io/<owner>/<image>:<tag> from a `docker save` archive in the broker's drop directory, without holding a registry token. The image must be on config.ghcr's allowlist; an existing release tag (1.2.3 / v1.2.3) is never overwritten while protectReleaseTags is on. Starts a background job and returns its id at once — poll ghcr_push_status. Runs on the owner's GHCR credential (classic PAT, write:packages).";

export const GHCR_PUSH_SCHEMA = {
	type: "object" as const,
	required: ["owner", "image", "tag", "archive"],
	additionalProperties: false,
	properties: {
		owner,
		image,
		tag: { type: "string", pattern: "^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$", description: "tag to push, e.g. \"1.4.0\" or \"latest\"" },
		archive: {
			type: "string",
			description: "a `docker save` archive (docker-archive or OCI layout) inside the configured drop directory — absolute, or relative to it. Must be a regular, group-readable file; symlinks and hard links are refused."
		}
	}
};

export const GHCR_PUSH_STATUS_DESCRIPTION =
	"Progress of a ghcr_push job (phase, blobs uploaded/skipped, bytes sent), then its final manifest digest or error. Omit job to list this owner's recent jobs. Jobs are kept in memory; a broker restart forgets them.";

export const GHCR_PUSH_STATUS_SCHEMA = {
	type: "object" as const,
	required: ["owner"],
	additionalProperties: false,
	properties: {
		owner,
		job: { type: "string", description: "job id returned by ghcr_push; omit to list this owner's recent jobs" }
	}
};

export const GHCR_TAGS_DESCRIPTION =
	"List the tags of an allowlisted image on ghcr.io/<owner>/<image>, e.g. to verify a push landed. Runs on the owner's GHCR credential (pull scope).";

export const GHCR_TAGS_SCHEMA = {
	type: "object" as const,
	required: ["owner", "image"],
	additionalProperties: false,
	properties: { owner, image }
};
