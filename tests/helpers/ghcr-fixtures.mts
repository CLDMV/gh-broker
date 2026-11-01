/**
 * Test fixtures for the GHCR verbs: a tar writer, builders for OCI-layout and
 * docker-archive image archives, and a fake OCI distribution registry (node:http) that
 * implements the token exchange, blob HEAD/upload, manifest HEAD/PUT and tag listing.
 */

import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

export const sha = (b: Buffer | string): string => `sha256:${createHash("sha256").update(b).digest("hex")}`;

// ---------- tar ----------

export interface TarSpec {
	name: string;
	data?: Buffer | string;
	type?: string; // "0" file, "1" hardlink, "2" symlink, "5" dir, "x" pax, "L" gnu long name, "g" global pax
	linkname?: string;
	prefix?: string;
	/** Override the size field (to build broken archives). */
	sizeField?: string;
	/** Write a base-256 size field. */
	base256?: boolean;
	badChecksum?: boolean;
}

function header(spec: TarSpec, size: number): Buffer {
	const h = Buffer.alloc(512, 0);
	h.write(spec.name.slice(0, 100), 0, "utf8");
	h.write("0000644\0", 100);
	h.write("0000000\0", 108);
	h.write("0000000\0", 116);
	if (spec.base256) {
		h[124] = 0x80;
		let n = size;
		for (let i = 135; i > 124; i--) {
			h[i] = n % 256;
			n = Math.floor(n / 256);
		}
	} else {
		h.write((spec.sizeField ?? size.toString(8).padStart(11, "0")) + "\0", 124);
	}
	h.write("00000000000\0", 136);
	h.write("        ", 148);
	h.write(spec.type ?? "0", 156);
	if (spec.linkname) h.write(spec.linkname.slice(0, 100), 157);
	h.write("ustar\0", 257);
	h.write("00", 263);
	if (spec.prefix) h.write(spec.prefix, 345);
	let sum = 0;
	for (let i = 0; i < 512; i++) sum += h[i]!;
	if (spec.badChecksum) sum += 1;
	h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
	return h;
}

const pad = (n: number): Buffer => Buffer.alloc((512 - (n % 512)) % 512, 0);

export function tar(entries: TarSpec[], { end = true }: { end?: boolean } = {}): Buffer {
	const parts: Buffer[] = [];
	for (const e of entries) {
		const data = e.data === undefined ? Buffer.alloc(0) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
		parts.push(header(e, data.length), data, pad(data.length));
	}
	if (end) parts.push(Buffer.alloc(1024, 0));
	return Buffer.concat(parts);
}

export function paxRecord(key: string, value: string): string {
	const body = ` ${key}=${value}\n`;
	let len = body.length + 1;
	while (`${len}${body}`.length !== len) len = `${len}${body}`.length;
	return `${len}${body}`;
}

// ---------- image archives ----------

export interface BuiltImage {
	archive: Buffer;
	config: Buffer;
	layers: Buffer[];
}

/** A small, valid uncompressed layer (itself a tar). */
export function layerTar(content: string): Buffer {
	return tar([{ name: "hello.txt", data: content }]);
}

const imageConfig = (diffIds: string[]): Buffer =>
	Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: diffIds }, config: {} }));

export interface OciOptions {
	/** Store layers gzip-compressed (as buildx does) instead of uncompressed (as docker save does). */
	gzip?: boolean;
	layerMediaType?: string;
	configMediaType?: string;
	manifestMediaType?: string;
	/** Wrap the manifest in a nested index (docker save on Docker 25+). */
	nested?: boolean;
	/** Extra entries in the top-level index (e.g. attestations, other platforms). */
	extraIndexEntries?: unknown[];
	annotations?: Record<string, string>;
	layerContents?: string[];
	/** Mutate the manifest object before it is serialized. */
	mutateManifest?: (m: Record<string, any>) => void;
	/** Drop these member names from the archive. */
	omit?: string[];
}

export function ociArchive(opts: OciOptions = {}): BuiltImage {
	const raw = (opts.layerContents ?? ["layer one", "layer two"]).map(layerTar);
	const layers = opts.gzip ? raw.map((l) => gzipSync(l)) : raw;
	const config = imageConfig(raw.map((l) => sha(l)));
	const layerType = opts.layerMediaType ?? (opts.gzip ? "application/vnd.oci.image.layer.v1.tar+gzip" : "application/vnd.oci.image.layer.v1.tar");
	const manifest: Record<string, any> = {
		schemaVersion: 2,
		mediaType: opts.manifestMediaType ?? "application/vnd.oci.image.manifest.v1+json",
		config: { mediaType: opts.configMediaType ?? "application/vnd.oci.image.config.v1+json", digest: sha(config), size: config.length },
		layers: layers.map((l) => ({ mediaType: layerType, digest: sha(l), size: l.length })),
		...(opts.annotations ? { annotations: opts.annotations } : {})
	};
	opts.mutateManifest?.(manifest);
	const manifestBytes = Buffer.from(JSON.stringify(manifest));
	const mDesc = { mediaType: manifest.mediaType, digest: sha(manifestBytes), size: manifestBytes.length, platform: { os: "linux", architecture: "amd64" } };
	const blobs: Array<[string, Buffer]> = [
		[sha(config), config],
		[sha(manifestBytes), manifestBytes],
		...layers.map((l): [string, Buffer] => [sha(l), l])
	];
	let index: Buffer;
	if (opts.nested) {
		const inner = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [mDesc, ...(opts.extraIndexEntries ?? [])] }));
		blobs.push([sha(inner), inner]);
		index = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: "application/vnd.oci.image.index.v1+json", digest: sha(inner), size: inner.length }] }));
	} else {
		index = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [mDesc, ...(opts.extraIndexEntries ?? [])] }));
	}
	const omit = new Set(opts.omit ?? []);
	const entries: TarSpec[] = [
		{ name: "oci-layout", data: '{"imageLayoutVersion":"1.0.0"}' },
		{ name: "index.json", data: index },
		{ name: "blobs/", type: "5" },
		{ name: "blobs/sha256/", type: "5" },
		...blobs.map(([d, b]) => ({ name: `blobs/sha256/${d.slice(7)}`, data: b }))
	].filter((e) => !omit.has(e.name));
	return { archive: tar(entries), config, layers };
}

/** Legacy `docker save` layout: manifest.json + <id>/layer.tar, with a symlinked duplicate layer. */
export function dockerArchive({ images = 1, gzipFirst = false }: { images?: number; gzipFirst?: boolean } = {}): BuiltImage {
	const l1 = layerTar("legacy one");
	const l2 = layerTar("legacy two");
	const first = gzipFirst ? gzipSync(l1) : l1;
	const config = imageConfig([sha(l1), sha(l2)]);
	const cfgName = `${sha(config).slice(7)}.json`;
	const entry = { Config: cfgName, RepoTags: ["hoot:latest"], Layers: ["aaa/layer.tar", "bbb/layer.tar", "ccc/layer.tar"] };
	const manifest = Buffer.from(JSON.stringify(Array.from({ length: images }, () => entry)));
	return {
		archive: tar([
			{ name: "aaa/", type: "5" },
			{ name: "aaa/layer.tar", data: first },
			{ name: "bbb/", type: "5" },
			{ name: "bbb/layer.tar", data: l2 },
			{ name: "ccc/", type: "5" },
			{ name: "ccc/layer.tar", type: "2", linkname: "../bbb/layer.tar" },
			{ name: cfgName, data: config },
			{ name: "manifest.json", data: manifest }
		]),
		config,
		layers: [first, l2, l2]
	};
}

// ---------- scratch dirs (inside the repo's gitignored tmp/, never /tmp) ----------

export function scratchDir(label: string): string {
	const dir = resolve(import.meta.dirname, "..", "..", "tmp", "tests", `${label}-${randomUUID().slice(0, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function removeDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

export { join };

// ---------- fake registry ----------

export interface FakeRegistryOptions {
	username?: string;
	password?: string;
	/** Tag-list page size (to exercise Link pagination). */
	tagPageSize?: number;
	/** Upload Location points at another host. */
	foreignLocation?: boolean;
	/** Tag-list Link points at another host. */
	foreignLink?: boolean;
	/** Echo the Authorization header back in manifest PUT errors (a leaky registry). */
	leakyErrors?: boolean;
	/** Echo the bare bearer token back in manifest PUT errors, after this many padding characters. */
	leakBareTokenAfter?: number;
	/** Refuse every manifest PUT with this status. */
	manifestStatus?: number;
	/** Invalidate the current token once, after this many authenticated requests in total. */
	expireTokenAfter?: number;
	/** Refuse every Bearer request (a token that never works). */
	rejectBearer?: boolean;
	/** Token endpoint answers with this status (simulates a bad/expired PAT). */
	tokenStatus?: number;
	/** Token endpoint answers 200 without a token. */
	tokenMissing?: boolean;
	/** Return 404 for tags/list (repository not created yet). */
	noRepo?: boolean;
}

export interface Recorded {
	method: string;
	path: string;
	authorization?: string;
}

export class FakeRegistry {
	readonly blobs = new Map<string, Buffer>();
	readonly manifests = new Map<string, { mediaType: string; bytes: Buffer }>();
	readonly requests: Recorded[] = [];
	readonly opts: Required<Pick<FakeRegistryOptions, "username" | "password">> & FakeRegistryOptions;
	tags: string[] = [];
	tokensIssued = 0;
	private server?: Server;
	private uploads = new Map<string, Buffer[]>();
	private validToken?: string;
	private authedCount = 0;
	private expired = false;
	base = "";

	constructor(opts: FakeRegistryOptions = {}) {
		this.opts = { username: "Shinrai", password: "ghp_testPatValue0123456789abcdefABCDEF", ...opts };
	}

	async start(): Promise<string> {
		this.server = createServer((req, res) => void this.handle(req, res));
		await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
		const addr = this.server.address() as { port: number };
		this.base = `http://127.0.0.1:${addr.port}`;
		return this.base;
	}

	async stop(): Promise<void> {
		await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
	}

	get currentToken(): string | undefined {
		return this.validToken;
	}

	private body(req: IncomingMessage): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => resolve(Buffer.concat(chunks)));
			req.on("error", reject);
		});
	}

	private json(res: ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}): void {
		const b = Buffer.from(JSON.stringify(obj));
		res.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(b.length), ...headers });
		res.end(b);
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", this.base);
		this.requests.push({ method: req.method ?? "", path: url.pathname + url.search, authorization: req.headers.authorization });
		const body = await this.body(req);

		if (url.pathname === "/token") {
			const expected = `Basic ${Buffer.from(`${this.opts.username}:${this.opts.password}`).toString("base64")}`;
			if (this.opts.tokenStatus) return this.json(res, this.opts.tokenStatus, { errors: [{ code: "DENIED", message: `denied for ${req.headers.authorization}` }] });
			if (req.headers.authorization !== expected) return this.json(res, 401, { errors: [{ code: "UNAUTHORIZED", message: "bad credentials" }] });
			if (this.opts.tokenMissing) return this.json(res, 200, {});
			this.validToken = `regtok-${++this.tokensIssued}-secretvalue`;
			return this.json(res, 200, { token: this.validToken });
		}

		if (this.opts.rejectBearer || req.headers.authorization !== `Bearer ${this.validToken}`) return this.json(res, 401, { errors: [{ code: "UNAUTHORIZED", message: "authentication required" }] });
		if (!this.expired && this.opts.expireTokenAfter !== undefined && ++this.authedCount > this.opts.expireTokenAfter) {
			this.expired = true;
			this.validToken = undefined;
			return this.json(res, 401, { errors: [{ code: "UNAUTHORIZED", message: "token expired" }] });
		}

		const m = /^\/v2\/(.+?)\/(blobs|manifests|tags)\/(.*)$/.exec(url.pathname);
		if (!m) return this.json(res, 404, { errors: [{ code: "NOT_FOUND", message: "no route" }] });
		const [, , kind, rest] = m;

		if (kind === "blobs" && rest!.startsWith("uploads/")) {
			const id = rest!.slice("uploads/".length);
			if (req.method === "POST" && id === "") {
				const uuid = randomUUID();
				this.uploads.set(uuid, []);
				const loc = this.opts.foreignLocation ? `http://evil.example/upload/${uuid}` : `${url.pathname}${uuid}`;
				res.writeHead(202, { Location: loc, "Content-Length": "0" });
				return void res.end();
			}
			const chunks = this.uploads.get(id);
			if (!chunks) return this.json(res, 404, { errors: [{ code: "BLOB_UPLOAD_UNKNOWN", message: "unknown upload" }] });
			if (req.method === "PATCH") {
				if (Number(req.headers["content-length"]) !== body.length) return this.json(res, 400, { errors: [{ code: "SIZE_INVALID", message: "length mismatch" }] });
				chunks.push(body);
				res.writeHead(202, { Location: url.pathname, "Content-Length": "0" });
				return void res.end();
			}
			if (req.method === "PUT") {
				const digest = url.searchParams.get("digest") ?? "";
				const all = Buffer.concat([...chunks, body]);
				if (sha(all) !== digest) return this.json(res, 400, { errors: [{ code: "DIGEST_INVALID", message: "digest mismatch" }] });
				this.blobs.set(digest, all);
				this.uploads.delete(id);
				res.writeHead(201, { "Docker-Content-Digest": digest, "Content-Length": "0" });
				return void res.end();
			}
		}
		if (kind === "blobs" && req.method === "HEAD") {
			res.writeHead(this.blobs.has(rest!) ? 200 : 404, { "Content-Length": "0" });
			return void res.end();
		}
		if (kind === "manifests" && req.method === "HEAD") {
			res.writeHead(this.manifests.has(rest!) ? 200 : 404, { "Content-Length": "0" });
			return void res.end();
		}
		if (kind === "manifests" && req.method === "PUT") {
			if (this.opts.manifestStatus) {
				return this.json(res, this.opts.manifestStatus, {
					errors: [
						{
							code: "DENIED",
							message:
								this.opts.leakBareTokenAfter !== undefined
									? `${"x".repeat(this.opts.leakBareTokenAfter)}${String(req.headers.authorization).replace(/^Bearer /, "")}`
									: this.opts.leakyErrors
										? `request had ${req.headers.authorization}`
										: "denied"
						}
					]
				});
			}
			const man = JSON.parse(body.toString("utf8")) as { config: { digest: string }; layers: Array<{ digest: string }> };
			for (const d of [man.config.digest, ...man.layers.map((l) => l.digest)]) {
				if (!this.blobs.has(d)) return this.json(res, 400, { errors: [{ code: "MANIFEST_BLOB_UNKNOWN", message: d }] });
			}
			this.manifests.set(rest!, { mediaType: String(req.headers["content-type"]), bytes: body });
			if (!this.tags.includes(rest!)) this.tags.push(rest!);
			res.writeHead(201, { "Docker-Content-Digest": sha(body), "Content-Length": "0" });
			return void res.end();
		}
		if (kind === "tags" && rest === "list") {
			if (this.opts.noRepo) return this.json(res, 404, { errors: [{ code: "NAME_UNKNOWN", message: "repository name not known to registry" }] });
			const size = this.opts.tagPageSize ?? 1000;
			const last = url.searchParams.get("last");
			const start = last ? this.tags.indexOf(last) + 1 : 0;
			const page = this.tags.slice(start, start + size);
			const more = start + size < this.tags.length;
			const linkBase = this.opts.foreignLink ? "http://evil.example" : "";
			const headers: Record<string, string> = more ? { Link: `<${linkBase}${url.pathname}?n=${size}&last=${page[page.length - 1]}>; rel="next"` } : {};
			return this.json(res, 200, { name: m[1], tags: page }, headers);
		}
		return this.json(res, 405, { errors: [{ code: "UNSUPPORTED", message: `${req.method} ${url.pathname}` }] });
	}
}
