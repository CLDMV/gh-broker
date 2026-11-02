/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/npm-registry.ts
 *	@Date: 2026-10-31T10:56:47-07:00 (1793469407)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-31T12:58:18-07:00 (1793476698)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The npm registry calls npm_scaffold makes, as plain HTTP requests (the same ones the npm CLI
 * sends; see its npm-registry-fetch, libnpmpublish and `npm trust` sources). The token and OTP
 * only ever travel in request headers: no error message, result or log line built here
 * contains either.
 */

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
	status: number;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
}>;

/** The registry wants a (fresh) one-time password for this request. */
export class NpmOtpRequired extends Error {
	constructor(what: string) {
		super(`npm: ${what} needs a one-time password (missing, expired or already used)`);
		this.name = "NpmOtpRequired";
	}
}

export class NpmHttpError extends Error {
	readonly status: number;
	constructor(what: string, status: number, detail: string) {
		super(`npm: ${what} failed (HTTP ${status})${detail ? `: ${detail}` : ""}`);
		this.name = "NpmHttpError";
		this.status = status;
	}
}

/** `@scope/name` → `@scope%2fname`, the form registry URLs use. */
export function escapePackageName(name: string): string {
	return name.replace("/", "%2f");
}

/** The registry's own message, kept short; never echoes request headers. */
function errorDetail(body: string): string {
	try {
		const j = JSON.parse(body) as { error?: unknown; message?: unknown; reason?: unknown };
		const msg = [j.error, j.message, j.reason].find((v) => typeof v === "string" && v);
		if (typeof msg === "string") return msg.slice(0, 300);
	} catch {
		/* not JSON */
	}
	return body.trim().slice(0, 300);
}

export interface PackumentVersion {
	scaffoldedBy?: unknown;
	[k: string]: unknown;
}

export interface Packument {
	name?: string;
	versions?: Record<string, PackumentVersion>;
	"dist-tags"?: Record<string, string>;
}

export interface TrustConfig {
	id?: string;
	[k: string]: unknown;
}

export class NpmRegistry {
	private readonly base: string;
	private readonly token: string;
	private readonly fetchImpl: FetchLike;

	constructor(opts: { registry?: string; token: string; fetch?: FetchLike }) {
		this.base = (opts.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
		this.token = opts.token;
		this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
	}

	get registry(): string {
		return this.base;
	}

	private async send(what: string, method: string, path: string, opts: { otp?: string; body?: unknown } = {}): Promise<{ status: number; body: string }> {
		const headers: Record<string, string> = {
			authorization: `Bearer ${this.token}`,
			accept: "application/json",
			"user-agent": "gh-broker (npm_scaffold)"
		};
		if (opts.otp) headers["npm-otp"] = opts.otp;
		if (opts.body !== undefined) headers["content-type"] = "application/json";
		const res = await this.fetchImpl(`${this.base}${path}`, {
			method,
			headers,
			...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {})
		});
		const body = await res.text();
		if (res.status === 401) {
			const auth = (res.headers.get("www-authenticate") ?? "").toLowerCase();
			if (auth.includes("otp") || /one-time pass/i.test(body)) throw new NpmOtpRequired(what);
		}
		return { status: res.status, body };
	}

	/**
	 * The package's registry document, or undefined when it does not exist (or is not visible to
	 * the token). `?write=true` reads from the primary rather than a cache, as npm itself does
	 * before a write: a stale 404 here is the one thing that could let a placeholder land on a
	 * package that already exists.
	 */
	async packument(name: string): Promise<Packument | undefined> {
		const res = await this.send("package lookup", "GET", `/${escapePackageName(name)}?write=true`);
		if (res.status === 404) return undefined;
		if (res.status !== 200) throw new NpmHttpError("package lookup", res.status, errorDetail(res.body));
		return JSON.parse(res.body) as Packument;
	}

	/** First publish of a package: PUT of the full document with the tarball attached. */
	async publish(document: unknown, name: string, otp: string): Promise<void> {
		const res = await this.send("publish", "PUT", `/${escapePackageName(name)}`, { otp, body: document });
		if (res.status < 200 || res.status >= 300) throw new NpmHttpError("publish", res.status, errorDetail(res.body));
	}

	/**
	 * Adds a GitHub Actions trusted publisher. A 409 means the package already has a trusted
	 * publisher, which may or may not be this one, so it is reported as `conflict` for the
	 * caller to check against listGithubTrust rather than as success.
	 */
	async addGithubTrust(name: string, claims: { repository: string; file: string }, otp: string): Promise<{ config?: TrustConfig; conflict: boolean }> {
		const body = [{ type: "github", claims: { repository: claims.repository, workflow_ref: { file: claims.file } }, permissions: ["createPackage"] }];
		const res = await this.send("trusted publisher setup", "POST", `/-/package/${escapePackageName(name)}/trust`, { otp, body });
		if (res.status === 409) return { conflict: true };
		if (res.status < 200 || res.status >= 300) throw new NpmHttpError("trusted publisher setup", res.status, errorDetail(res.body));
		let parsed: unknown;
		try {
			parsed = JSON.parse(res.body);
		} catch {
			return { conflict: false };
		}
		const first = Array.isArray(parsed) ? parsed[0] : parsed;
		return { config: first && typeof first === "object" ? (first as TrustConfig) : undefined, conflict: false };
	}

	/** The package's trusted-publisher configurations (`npm trust list`). May need an OTP. */
	async listTrust(name: string, otp?: string): Promise<TrustConfig[]> {
		const res = await this.send("trusted publisher lookup", "GET", `/-/package/${escapePackageName(name)}/trust`, otp ? { otp } : {});
		if (res.status !== 200) throw new NpmHttpError("trusted publisher lookup", res.status, errorDetail(res.body));
		let parsed: unknown;
		try {
			parsed = JSON.parse(res.body);
		} catch {
			throw new NpmHttpError("trusted publisher lookup", res.status, "response is not JSON");
		}
		return (Array.isArray(parsed) ? parsed : [parsed]).filter((c): c is TrustConfig => Boolean(c) && typeof c === "object");
	}
}

/**
 * The latest published version of a package, from the public registry (`GET /<name>/latest`,
 * no credentials sent). Undefined when the package does not exist.
 */
export async function latestVersion(name: string, opts: { registry?: string; fetch?: FetchLike } = {}): Promise<string | undefined> {
	const base = (opts.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
	const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
	const res = await fetchImpl(`${base}/${escapePackageName(name)}/latest`, { method: "GET", headers: { accept: "application/json", "user-agent": "gh-broker (report_dependents)" } });
	const body = await res.text();
	if (res.status === 404) return undefined;
	if (res.status !== 200) throw new NpmHttpError("latest lookup", res.status, errorDetail(body));
	const version = (JSON.parse(body) as { version?: unknown }).version;
	if (typeof version !== "string") throw new NpmHttpError("latest lookup", res.status, "response has no version");
	return version;
}
