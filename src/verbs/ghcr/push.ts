/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/ghcr/push.ts
 *	@Date: 2026-10-31T11:00:50-07:00 (1793469650)
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
 * Pushes one planned image (see archive.ts) to a registry repository.
 *
 * Phases:
 *  1. preparing — for every layer the archive holds uncompressed, gzip it once just to
 *     learn the compressed digest and size. This costs a second pass of CPU, but it means
 *     the blob `HEAD` check works for those layers too (a re-push of an unchanged image
 *     uploads nothing), and nothing has to be buffered or written to disk: the broker's
 *     unit has no writable scratch space.
 *  2. uploading — config then layers: `HEAD` each blob and skip it when present,
 *     otherwise stream it. Compressed-on-push layers are gzipped again with the same
 *     settings; zlib is deterministic, and the registry rejects the upload if the bytes
 *     don't match the digest computed in phase 1.
 *  3. manifest — re-check a protected release tag (another push may have landed it while
 *     this one waited in the queue), then `PUT` the manifest under the tag.
 */

import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { PassThrough, Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MEDIA, type BlobPlan, type ImagePlan } from "./archive.ts";
import type { Registry } from "./registry.ts";

export const RELEASE_TAG = /^v?\d+\.\d+\.\d+$/;
const GZIP_LEVEL = 6;

export type Phase = "queued" | "preparing" | "uploading" | "manifest" | "done";

export interface PushProgress {
	phase: Phase;
	layersTotal: number;
	blobsUploaded: number;
	blobsSkipped: number;
	/** Bytes of every blob the image references, as stored in the registry. Known once preparing ends. */
	bytesTotal: number;
	bytesSent: number;
}

export interface PushResult {
	digest: string;
	mediaType: string;
	/** Total size of config + layers in the registry. */
	size: number;
	blobsUploaded: number;
	blobsSkipped: number;
}

interface Descriptor {
	mediaType: string;
	digest: string;
	size: number;
}

export class PushRefused extends Error {}

function memberStream(fd: number, plan: BlobPlan): Readable {
	if (plan.member.size === 0) {
		const empty = new PassThrough();
		empty.end();
		return empty;
	}
	return createReadStream("", { fd, start: plan.member.offset, end: plan.member.offset + plan.member.size - 1, autoClose: false });
}

function gzipStream(fd: number, plan: BlobPlan): Readable {
	const src = memberStream(fd, plan);
	const gz = createGzip({ level: GZIP_LEVEL });
	src.on("error", (e) => gz.destroy(e));
	return src.pipe(gz);
}

async function gzipDigest(fd: number, plan: BlobPlan): Promise<{ digest: string; size: number }> {
	const hash = createHash("sha256");
	let size = 0;
	await pipeline(
		gzipStream(fd, plan),
		new Writable({
			write(chunk: Buffer, _enc, cb) {
				hash.update(chunk);
				size += chunk.length;
				cb();
			}
		})
	);
	return { digest: `sha256:${hash.digest("hex")}`, size };
}

const sha256 = (b: Buffer): string => `sha256:${createHash("sha256").update(b).digest("hex")}`;

export async function pushImage(
	registry: Registry,
	fd: number,
	plan: ImagePlan,
	tag: string,
	opts: { protectReleaseTags: boolean; onProgress?: (p: PushProgress) => void }
): Promise<PushResult> {
	const progress: PushProgress = { phase: "preparing", layersTotal: plan.layers.length, blobsUploaded: 0, blobsSkipped: 0, bytesTotal: 0, bytesSent: 0 };
	const report = () => opts.onProgress?.({ ...progress });
	report();

	const layers: Descriptor[] = [];
	for (const l of plan.layers) {
		if (l.compress) {
			const { digest, size } = await gzipDigest(fd, l);
			layers.push({ mediaType: l.mediaType, digest, size });
		} else {
			layers.push({ mediaType: l.mediaType, digest: l.sourceDigest ?? (await rawDigest(fd, l)), size: l.sourceSize });
		}
	}
	const config: Descriptor = { mediaType: plan.config.mediaType, digest: plan.config.digest, size: plan.config.sourceSize };
	progress.bytesTotal = config.size + layers.reduce((n, d) => n + d.size, 0);
	progress.phase = "uploading";
	report();

	const blobs: Array<{ desc: Descriptor; plan: BlobPlan }> = [{ desc: config, plan: plan.config }, ...layers.map((desc, i) => ({ desc, plan: plan.layers[i]! }))];
	const seen = new Set<string>();
	for (const { desc, plan: p } of blobs) {
		if (seen.has(desc.digest) || (await registry.blobExists(desc.digest))) {
			seen.add(desc.digest);
			progress.blobsSkipped++;
			report();
			continue;
		}
		seen.add(desc.digest);
		await registry.uploadBlob(desc.digest, desc.size, () => (p.compress ? gzipStream(fd, p) : memberStream(fd, p)), (n) => {
			progress.bytesSent += n;
			report();
		});
		progress.blobsUploaded++;
		report();
	}

	progress.phase = "manifest";
	report();
	let bytes: Buffer;
	let mediaType: string;
	if (plan.verbatimManifest) {
		bytes = plan.verbatimManifest.bytes;
		mediaType = plan.verbatimManifest.mediaType;
	} else {
		mediaType = MEDIA.ociManifest;
		const cfg = { ...config, mediaType: config.mediaType === MEDIA.dockerConfig ? MEDIA.ociConfig : config.mediaType };
		bytes = Buffer.from(
			JSON.stringify({
				schemaVersion: 2,
				mediaType,
				config: cfg,
				layers: layers.map((l) => ({ ...l, mediaType: l.mediaType === MEDIA.dockerLayerGzip ? MEDIA.ociLayerGzip : l.mediaType })),
				...(plan.annotations ? { annotations: plan.annotations } : {})
			})
		);
	}
	if (opts.protectReleaseTags && RELEASE_TAG.test(tag) && (await registry.manifestExists(tag))) {
		throw new PushRefused(`ghcr_push: tag ${tag} already exists on ${registry.repository} and release tags are protected — push a new version instead`);
	}
	await registry.putManifest(tag, mediaType, bytes);
	progress.phase = "done";
	report();
	return { digest: sha256(bytes), mediaType, size: progress.bytesTotal, blobsUploaded: progress.blobsUploaded, blobsSkipped: progress.blobsSkipped };
}

/** sha256 of a member streamed from the archive (docker-archive layers that are already compressed). */
async function rawDigest(fd: number, plan: BlobPlan): Promise<string> {
	const hash = createHash("sha256");
	await pipeline(
		memberStream(fd, plan),
		new Writable({
			write(chunk: Buffer, _enc, cb) {
				hash.update(chunk);
				cb();
			}
		})
	);
	return `sha256:${hash.digest("hex")}`;
}
