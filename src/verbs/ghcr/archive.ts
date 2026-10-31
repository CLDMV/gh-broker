/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/ghcr/archive.ts
 *	@Date: 2026-10-31T10:59:13-07:00 (1793469553)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-31T11:13:29-07:00 (1793470409)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Opens an image archive from the GHCR drop directory and works out what to push.
 *
 * The archive path comes from the agent, and the broker can read files the agent can't
 * (its own credentials among them). A path that resolves outside the drop directory would
 * let the agent have the broker upload a secret into a registry the agent can then pull
 * from. So the file is opened exactly once, by descriptor, and every check runs against
 * that descriptor rather than the path:
 *
 *  1. lexical: the normalized path must sit under `dropDir` (refused before any open, so a
 *     path elsewhere reveals nothing about what exists there);
 *  2. `O_NOFOLLOW | O_NONBLOCK`: the last component can't be a symlink, and a FIFO can't
 *     hang the open;
 *  3. `fstat`: a regular file, exactly one link (no hard link to a file elsewhere), not
 *     empty, not over `maxArchiveBytes`;
 *  4. `/proc/self/fd/<fd>`: the file actually opened lives under the real `dropDir`, which
 *     catches a symlinked parent directory or a rename race between the checks.
 *
 * All later reads use positional reads on that descriptor; the path is never reopened.
 *
 * Two archive formats are read:
 *  - OCI image layout (`index.json` + `blobs/sha256/…`): `docker save` on Docker 25+,
 *    `docker buildx build --output type=oci`, `skopeo copy … oci-archive:`.
 *  - docker-archive (`manifest.json` only): `docker save` on older Docker.
 *
 * Layers that are already gzip/zstd-compressed are pushed byte-for-byte. Uncompressed
 * layers (what `docker save` writes for the classic image store) are gzipped on the fly at
 * push time, and the manifest is then rebuilt as an OCI image manifest.
 */

import { closeSync, constants, fstatSync, openSync, readlinkSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";
import { indexTar, peekMember, readMember, type TarIndex, type TarMember } from "./tar.ts";

export const MEDIA = {
	ociIndex: "application/vnd.oci.image.index.v1+json",
	ociManifest: "application/vnd.oci.image.manifest.v1+json",
	ociConfig: "application/vnd.oci.image.config.v1+json",
	ociLayer: "application/vnd.oci.image.layer.v1.tar",
	ociLayerGzip: "application/vnd.oci.image.layer.v1.tar+gzip",
	ociLayerZstd: "application/vnd.oci.image.layer.v1.tar+zstd",
	dockerList: "application/vnd.docker.distribution.manifest.list.v2+json",
	dockerManifest: "application/vnd.docker.distribution.manifest.v2+json",
	dockerConfig: "application/vnd.docker.container.image.v1+json",
	dockerLayer: "application/vnd.docker.image.rootfs.diff.tar",
	dockerLayerGzip: "application/vnd.docker.image.rootfs.diff.tar.gzip"
} as const;

const MANIFEST_TYPES = new Set<string>([MEDIA.ociManifest, MEDIA.dockerManifest]);
const INDEX_TYPES = new Set<string>([MEDIA.ociIndex, MEDIA.dockerList]);
const LAYER_TYPES = new Set<string>([MEDIA.ociLayer, MEDIA.ociLayerGzip, MEDIA.ociLayerZstd, MEDIA.dockerLayer, MEDIA.dockerLayerGzip]);
const CONFIG_TYPES = new Set<string>([MEDIA.ociConfig, MEDIA.dockerConfig]);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_JSON = 4 * 1024 * 1024;
export const MAX_LAYERS = 256;

export class ArchiveError extends Error {}

const fail = (msg: string): never => {
	throw new ArchiveError(`archive: ${msg}`);
};

export interface OpenedArchive {
	fd: number;
	/** The real path of the opened file (inside dropDir). */
	path: string;
	size: number;
	close(): void;
}

/** Securely open `input` (absolute, or relative to dropDir) — see the file comment for the checks. */
export function openArchive(input: unknown, dropDir: string, maxBytes: number): OpenedArchive {
	if (typeof input !== "string" || !input || input.length > 4096 || input.includes("\0")) fail('"archive" must be a file path inside the drop directory');
	const candidate = normalize(isAbsolute(input as string) ? (input as string) : join(dropDir, input as string));
	if (!candidate.startsWith(`${dropDir}/`)) fail(`"archive" must be inside the drop directory ${dropDir}`);

	let realDrop: string;
	try {
		realDrop = realpathSync(dropDir);
	} catch {
		return fail(`drop directory ${dropDir} does not exist — the installer creates it`);
	}

	let fd: number;
	try {
		fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ELOOP") return fail(`${candidate} is a symlink — put the archive file itself in the drop directory`);
		if (code === "ENOENT" || code === "ENOTDIR") return fail(`${candidate} not found`);
		if (code === "EACCES") return fail(`${candidate} is not readable by the broker — make it group-readable (chmod g+r)`);
		return fail(`cannot open ${candidate} (${code ?? "error"})`);
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) fail(`${candidate} is not a regular file`);
		if (st.nlink !== 1) fail(`${candidate} has ${st.nlink} hard links — copy the archive instead of linking it`);
		if (st.size === 0) fail(`${candidate} is empty`);
		if (st.size > maxBytes) fail(`${candidate} is ${st.size} bytes — over the ${maxBytes}-byte limit (ghcr.maxArchiveBytes)`);
		const real = readlinkSync(`/proc/self/fd/${fd}`);
		if (!real.startsWith(`${realDrop}/`)) fail(`${candidate} resolves outside the drop directory`);
		let closed = false;
		return {
			fd,
			path: real,
			size: st.size,
			close() {
				if (closed) return;
				closed = true;
				closeSync(fd);
			}
		};
	} catch (err) {
		closeSync(fd);
		throw err;
	}
}

/** One blob to push. `digest`/`size` are what the registry will hold (known up front unless `compress`). */
export interface BlobPlan {
	member: TarMember;
	mediaType: string;
	/** Digest + size in the archive (for a compressed-on-push layer: of the uncompressed tar). */
	sourceDigest?: string;
	sourceSize: number;
	/** Gzip this layer while pushing it (archive holds it uncompressed). */
	compress: boolean;
}

export interface ImagePlan {
	format: "oci-layout" | "docker-archive";
	config: BlobPlan & { digest: string };
	layers: BlobPlan[];
	/** Set when the archive's own manifest can be pushed unchanged (nothing recompressed or retyped). */
	verbatimManifest?: { bytes: Buffer; mediaType: string; digest: string };
	annotations?: Record<string, string>;
}

const sha256 = (b: Buffer): string => `sha256:${createHash("sha256").update(b).digest("hex")}`;

function parseJson(buf: Buffer, what: string): unknown {
	try {
		return JSON.parse(buf.toString("utf8"));
	} catch {
		return fail(`${what} is not valid JSON`);
	}
}

interface Descriptor {
	mediaType?: string;
	digest?: string;
	size?: number;
	annotations?: Record<string, string>;
	platform?: { os?: string; architecture?: string };
}

function blobMember(index: TarIndex, digest: unknown, what: string): TarMember {
	if (typeof digest !== "string" || !DIGEST.test(digest)) fail(`${what} has an unsupported digest (only sha256 is accepted)`);
	const m = index.files.get(`blobs/sha256/${(digest as string).slice("sha256:".length)}`);
	if (!m) fail(`${what} ${digest} is missing from the archive`);
	return m as TarMember;
}

function readBlobJson(fd: number, index: TarIndex, d: Descriptor, what: string): { bytes: Buffer; json: unknown } {
	const m = blobMember(index, d.digest, what);
	const bytes = readMember(fd, m, MAX_JSON, what);
	if (sha256(bytes) !== d.digest) fail(`${what} does not match its digest`);
	return { bytes, json: parseJson(bytes, what) };
}

/**
 * The image entries of an index: buildx attestation manifests and unknown/unknown platform
 * entries are not images. When several remain, keep only those whose manifest blob is in
 * the archive: with the containerd image store, `docker save` writes the image's whole
 * multi-platform index but only the blobs of the platform that was pulled.
 */
function images(manifests: unknown, index: TarIndex): Descriptor[] {
	if (!Array.isArray(manifests)) return fail("index has no manifests list");
	const list = (manifests as Descriptor[]).filter(
		(d) => d?.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest" && !(d?.platform?.os === "unknown" && d?.platform?.architecture === "unknown")
	);
	if (list.length <= 1) return list;
	return list.filter((d) => typeof d?.digest === "string" && DIGEST.test(d.digest) && index.files.has(`blobs/sha256/${d.digest.slice("sha256:".length)}`));
}

function sniff(fd: number, m: TarMember): "gzip" | "zstd" | "none" {
	const head = peekMember(fd, m, 4);
	if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return "gzip";
	if (head.length >= 4 && head.readUInt32LE(0) === 0xfd2fb528) return "zstd";
	return "none";
}

/** Decide how a layer is pushed: verbatim when already compressed, gzipped on the fly otherwise. */
function layerPlan(fd: number, m: TarMember, declared: string | undefined, sourceDigest: string | undefined): BlobPlan {
	if (declared !== undefined && !LAYER_TYPES.has(declared)) fail(`layer media type "${declared}" is not supported (non-distributable and foreign layers are refused)`);
	const kind = sniff(fd, m);
	if (kind === "gzip") {
		const mediaType = declared === MEDIA.ociLayerGzip || declared === MEDIA.dockerLayerGzip ? declared : MEDIA.ociLayerGzip;
		return { member: m, mediaType, sourceDigest, sourceSize: m.size, compress: false };
	}
	if (kind === "zstd") return { member: m, mediaType: MEDIA.ociLayerZstd, sourceDigest, sourceSize: m.size, compress: false };
	return { member: m, mediaType: MEDIA.ociLayerGzip, sourceDigest, sourceSize: m.size, compress: true };
}

/** Read the archive's index/manifest and plan the push. Reads only small JSON members and 4-byte layer heads. */
export function planImage(fd: number, size: number): ImagePlan {
	const index = indexTar(fd, size);
	const top = index.files.get("index.json");
	if (top) return planOciLayout(fd, index, top);
	const legacy = index.files.get("manifest.json");
	if (legacy) return planDockerArchive(fd, index, legacy);
	return fail("not an image archive (no index.json or manifest.json) — create it with `docker save <image> -o <file>`");
}

function planOciLayout(fd: number, index: TarIndex, top: TarMember): ImagePlan {
	const root = parseJson(readMember(fd, top, MAX_JSON, "index.json"), "index.json") as { manifests?: unknown };
	let list = images(root.manifests, index);
	let desc: Descriptor | undefined = list.length === 1 ? list[0] : undefined;
	// docker save / buildx often wrap the image manifest in one more index level.
	if (desc && INDEX_TYPES.has(desc.mediaType ?? "")) {
		const nested = readBlobJson(fd, index, desc, "nested index").json as { manifests?: unknown };
		list = images(nested.manifests, index);
		desc = list.length === 1 ? list[0] : undefined;
	}
	if (!desc) fail(`archive holds ${list.length} images — save exactly one single-platform image per archive`);
	const d = desc as Descriptor;
	if (!MANIFEST_TYPES.has(d.mediaType ?? "")) fail(`manifest media type "${d.mediaType}" is not supported`);
	const { bytes, json } = readBlobJson(fd, index, d, "image manifest");
	const man = json as { config?: Descriptor; layers?: Descriptor[]; annotations?: Record<string, string> };
	if (!man.config || !Array.isArray(man.layers)) fail("image manifest has no config or layers");
	if (man.layers!.length > MAX_LAYERS) fail(`image has ${man.layers!.length} layers — at most ${MAX_LAYERS}`);

	const cfg = man.config as Descriptor;
	if (!CONFIG_TYPES.has(cfg.mediaType ?? "")) fail(`config media type "${cfg.mediaType}" is not supported`);
	const cfgMember = blobMember(index, cfg.digest, "image config");
	if (cfgMember.size !== cfg.size) fail("image config size does not match its descriptor");

	let changed = false;
	const layers = man.layers!.map((l, i) => {
		const m = blobMember(index, l.digest, `layer ${i + 1}`);
		if (m.size !== l.size) fail(`layer ${i + 1} size does not match its descriptor`);
		const plan = layerPlan(fd, m, l.mediaType, l.digest);
		if (plan.compress || plan.mediaType !== l.mediaType) changed = true;
		return plan;
	});
	return {
		format: "oci-layout",
		config: { member: cfgMember, mediaType: cfg.mediaType!, digest: cfg.digest!, sourceDigest: cfg.digest, sourceSize: cfgMember.size, compress: false },
		layers,
		...(changed ? {} : { verbatimManifest: { bytes, mediaType: d.mediaType!, digest: d.digest! } }),
		...(man.annotations ? { annotations: man.annotations } : {})
	};
}

function planDockerArchive(fd: number, index: TarIndex, legacy: TarMember): ImagePlan {
	const list = parseJson(readMember(fd, legacy, MAX_JSON, "manifest.json"), "manifest.json");
	if (!Array.isArray(list) || list.length !== 1) fail(`archive holds ${Array.isArray(list) ? list.length : 0} images — save exactly one image per archive`);
	const entry = (list as Array<{ Config?: unknown; Layers?: unknown }>)[0]!;
	if (typeof entry.Config !== "string" || !Array.isArray(entry.Layers)) fail("manifest.json entry has no Config or Layers");
	if ((entry.Layers as unknown[]).length > MAX_LAYERS) fail(`image has ${(entry.Layers as unknown[]).length} layers — at most ${MAX_LAYERS}`);

	const member = (name: unknown, what: string): TarMember => {
		const m = typeof name === "string" ? index.files.get(name.replace(/^\.?\//, "")) : undefined;
		if (!m) fail(`${what} "${String(name)}" is missing from the archive`);
		return m as TarMember;
	};
	const cfgMember = member(entry.Config, "image config");
	const cfgBytes = readMember(fd, cfgMember, MAX_JSON, "image config");
	parseJson(cfgBytes, "image config");
	const layers = (entry.Layers as unknown[]).map((name, i) => layerPlan(fd, member(name, `layer ${i + 1}`), undefined, undefined));
	return {
		format: "docker-archive",
		config: { member: cfgMember, mediaType: MEDIA.ociConfig, digest: sha256(cfgBytes), sourceSize: cfgMember.size, compress: false },
		layers
	};
}
