/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/ghcr/registry.ts
 *	@Date: 2026-10-31T11:00:07-07:00 (1793469607)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-31T13:01:59-07:00 (1793476919)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * OCI distribution API client for ghcr.io, driven with node:https (no new dependency, no
 * docker socket, no skopeo).
 *
 * Credential handling:
 *  - The classic PAT is used for exactly one request: the Basic-auth exchange at
 *    `<base>/token` for a short-lived registry token scoped to one repository.
 *  - The registry token goes only to `<base>` itself. Every URL the registry hands back
 *    (upload `Location`, pagination `Link`) is resolved and refused unless its origin is
 *    `<base>`'s, and redirects are never followed, so neither secret can be carried to
 *    another host.
 *  - Every error message leaving this module goes through `clean()`, which replaces both
 *    secret values and anything shaped like an auth header or a GitHub token. Registry
 *    error bodies are reduced to their `code: message` pairs; response headers are never
 *    included.
 *
 * Upload flow per blob (the one go-containerregistry uses against GHCR):
 * `POST /v2/<name>/blobs/uploads/` → `PATCH <location>` streaming the bytes with a known
 * Content-Length → `PUT <location>?digest=…`. A 401 mid-flow (expired registry token)
 * re-runs the token exchange once and restarts that blob.
 */

import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";

export const GHCR_BASE = "https://ghcr.io";
const MAX_BODY = 1024 * 1024;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TAG_PAGES = 20;
export const MANIFEST_ACCEPT = [
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
	"application/vnd.docker.distribution.manifest.list.v2+json"
].join(", ");

export class RegistryError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.status = status;
	}
}

interface Res {
	status: number;
	headers: IncomingHttpHeaders;
	body: Buffer;
}

type Body = Buffer | (() => Readable) | undefined;

export interface RegistryOptions {
	/** Registry origin. Always GHCR_BASE in production; tests point it at a local fake. */
	base?: string;
	username: string;
	password: string;
	/** "<owner>/<image>" */
	repository: string;
}

export class Registry {
	private readonly base: URL;
	private readonly username: string;
	private readonly password: string;
	readonly repository: string;
	private token?: string;
	private scope?: string;

	constructor(opts: RegistryOptions) {
		this.base = new URL(opts.base ?? GHCR_BASE);
		this.username = opts.username;
		this.password = opts.password;
		this.repository = opts.repository;
	}

	/** The registry host name as used in image references (e.g. "ghcr.io"). */
	get host(): string {
		return this.base.host;
	}

	/** Replace every secret (and anything that looks like one) in a message. */
	clean(msg: string): string {
		let out = msg;
		for (const s of [this.password, this.token]) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
		return out
			.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
			.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted]")
			.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]");
	}

	private err(step: string, res: Res): RegistryError {
		let detail = "";
		try {
			const j = JSON.parse(res.body.toString("utf8")) as { errors?: Array<{ code?: unknown; message?: unknown }> };
			if (Array.isArray(j.errors)) detail = j.errors.map((e) => `${String(e.code ?? "")}: ${String(e.message ?? "")}`).join("; ");
		} catch {
			detail = res.body.toString("utf8").replace(/\s+/g, " ").trim();
		}
		const hint = res.status === 401 || res.status === 403 ? " — check the ghcr credential is a classic PAT with write:packages, not expired, and allowed for this package" : "";
		// Scrub before truncating: a secret cut at the 300-character boundary would no longer
		// match the exact-value replacement.
		const shown = this.clean(detail).slice(0, 300);
		return new RegistryError(this.clean(`ghcr: ${step} failed: HTTP ${res.status}${shown ? ` (${shown})` : ""}${hint}`), res.status);
	}

	/** Resolve a registry-provided URL and refuse anything that would leave the registry's origin. */
	private sameOrigin(raw: string, step: string): URL {
		let u: URL;
		try {
			u = new URL(raw, this.base);
		} catch {
			throw new RegistryError(`ghcr: ${step}: registry returned an unparseable URL`);
		}
		if (u.origin !== this.base.origin) throw new RegistryError(`ghcr: ${step}: registry pointed at another host (${u.host}) — refused`);
		return u;
	}

	private url(path: string): URL {
		return new URL(path, this.base);
	}

	private send(method: string, url: URL, headers: Record<string, string>, body: Body, onBytes?: (n: number) => void): Promise<Res> {
		const fn = url.protocol === "https:" ? httpsRequest : httpRequest;
		return new Promise<Res>((resolve, reject) => {
			const req = fn(url, { method, headers }, (res) => {
				const chunks: Buffer[] = [];
				let len = 0;
				res.on("data", (c: Buffer) => {
					if (len < MAX_BODY) chunks.push(c);
					len += c.length;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).subarray(0, MAX_BODY) }));
				res.on("error", reject);
			});
			req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error(`${method} timed out`)));
			req.on("error", (e) => reject(new RegistryError(this.clean(`ghcr: ${method} ${url.pathname} failed: ${e.message}`))));
			if (body === undefined) req.end();
			else if (Buffer.isBuffer(body)) req.end(body);
			else {
				const src = body();
				src.on("error", (e) => req.destroy(e));
				if (onBytes) src.on("data", (c: Buffer) => onBytes(c.length));
				src.pipe(req);
			}
		});
	}

	/** Exchange the PAT for a registry token scoped to this repository. */
	async login(actions: "pull" | "push,pull"): Promise<void> {
		const u = this.url("/token");
		u.searchParams.set("service", this.base.host);
		u.searchParams.set("scope", `repository:${this.repository}:${actions}`);
		const basic = Buffer.from(`${this.username}:${this.password}`).toString("base64");
		const res = await this.send("GET", u, { Authorization: `Basic ${basic}`, Accept: "application/json" }, undefined);
		if (res.status !== 200) throw this.err("token exchange", res);
		let token: unknown;
		try {
			const j = JSON.parse(res.body.toString("utf8")) as { token?: unknown; access_token?: unknown };
			token = j.token ?? j.access_token;
		} catch {
			/* handled below */
		}
		if (typeof token !== "string" || !token) throw new RegistryError("ghcr: token exchange returned no token");
		this.token = token;
		this.scope = actions;
	}

	/** One request with the registry token; on 401 re-login once and retry. */
	private async authed(method: string, url: URL, headers: Record<string, string>, body: Body, onBytes?: (n: number) => void): Promise<Res> {
		if (!this.token) await this.login("pull");
		const go = () => this.send(method, url, { ...headers, Authorization: `Bearer ${this.token}` }, body, onBytes);
		const res = await go();
		if (res.status !== 401) return res;
		await this.login((this.scope as "pull" | "push,pull") ?? "pull");
		return go();
	}

	async blobExists(digest: string): Promise<boolean> {
		const res = await this.authed("HEAD", this.url(`/v2/${this.repository}/blobs/${digest}`), {}, undefined);
		if (res.status >= 200 && res.status < 400) return true; // a redirect to storage still means "present"
		if (res.status === 404) return false;
		throw this.err(`checking blob ${digest}`, res);
	}

	/**
	 * Upload one blob whose digest and size are known. `body` must produce a fresh stream
	 * each call (a retry after a 401 restarts the upload). `onBytes` reports progress.
	 */
	async uploadBlob(digest: string, size: number, body: () => Readable, onBytes?: (n: number) => void): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			let sent = 0;
			const count = (n: number) => {
				sent += n;
				onBytes?.(n);
			};
			const res = await this.tryUpload(digest, size, body, count);
			if (res === "ok") return;
			if (attempt >= 1) throw this.err(`uploading blob ${digest}`, res);
			onBytes?.(-sent); // roll the progress counter back before the retry
			await this.login("push,pull");
		}
	}

	private async tryUpload(digest: string, size: number, body: () => Readable, onBytes: (n: number) => void): Promise<"ok" | Res> {
		const start = await this.authed("POST", this.url(`/v2/${this.repository}/blobs/uploads/`), { "Content-Length": "0" }, Buffer.alloc(0));
		if (start.status === 401) return start;
		if (start.status !== 202 || typeof start.headers.location !== "string") throw this.err("starting a blob upload", start);
		const patchUrl = this.sameOrigin(start.headers.location, "blob upload");

		const auth = { Authorization: `Bearer ${this.token}` };
		const patch = await this.send("PATCH", patchUrl, { ...auth, "Content-Type": "application/octet-stream", "Content-Length": String(size) }, body, onBytes);
		if (patch.status === 401) return patch;
		if (patch.status !== 202 && patch.status !== 204) throw this.err(`uploading blob ${digest}`, patch);
		const putUrl = this.sameOrigin(typeof patch.headers.location === "string" ? patch.headers.location : patchUrl.href, "blob upload");
		putUrl.searchParams.set("digest", digest);

		const done = await this.send("PUT", putUrl, { ...auth, "Content-Length": "0" }, Buffer.alloc(0));
		if (done.status === 401) return done;
		if (done.status !== 201) throw this.err(`finishing blob ${digest}`, done);
		return "ok";
	}

	/** True when `reference` (tag or digest) already names a manifest in this repository. */
	async manifestExists(reference: string): Promise<boolean> {
		const res = await this.authed("HEAD", this.url(`/v2/${this.repository}/manifests/${reference}`), { Accept: MANIFEST_ACCEPT }, undefined);
		if (res.status === 200) return true;
		if (res.status === 404) return false;
		throw this.err(`checking tag ${reference}`, res);
	}

	async putManifest(tag: string, mediaType: string, bytes: Buffer): Promise<void> {
		const res = await this.authed("PUT", this.url(`/v2/${this.repository}/manifests/${tag}`), { "Content-Type": mediaType, "Content-Length": String(bytes.length) }, bytes);
		if (res.status !== 201 && res.status !== 200) throw this.err(`pushing manifest for tag ${tag}`, res);
	}

	/** Every tag in the repository; `undefined` when the repository doesn't exist yet. */
	async listTags(): Promise<string[] | undefined> {
		const tags: string[] = [];
		let url: URL | undefined = this.url(`/v2/${this.repository}/tags/list?n=1000`);
		for (let page = 0; url && page < MAX_TAG_PAGES; page++) {
			const res = await this.authed("GET", url, { Accept: "application/json" }, undefined);
			if (res.status === 404) return undefined;
			if (res.status !== 200) throw this.err("listing tags", res);
			let j: { tags?: unknown };
			try {
				j = JSON.parse(res.body.toString("utf8")) as { tags?: unknown };
			} catch {
				throw new RegistryError("ghcr: listing tags returned invalid JSON");
			}
			if (Array.isArray(j.tags)) for (const t of j.tags) if (typeof t === "string") tags.push(t);
			const link = typeof res.headers.link === "string" ? /<([^>]+)>;\s*rel="next"/.exec(res.headers.link) : null;
			url = link ? this.sameOrigin(link[1]!, "listing tags") : undefined;
		}
		return tags;
	}
}
