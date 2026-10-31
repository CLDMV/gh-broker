import { describe, it, expect, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { npmScaffold, placeholderDocument, NPM_SCAFFOLD_SCHEMA, PLACEHOLDER_VERSION, SCAFFOLD_MARKER } from "../src/verbs/npm_scaffold.ts";
import { NpmRegistry, NpmOtpRequired, NpmHttpError, escapePackageName, type FetchLike } from "../src/verbs/npm-registry.ts";
import { buildTarball, tarballDigests } from "../src/verbs/npm-tarball.ts";

const TOKEN = "npm_SECRETTOKENVALUE";
const OTP = "123456";
const OTP2 = "654321";
const PKG = "@cldmv/new-thing";

/** Read the ustar entries back out of a gzipped tarball. */
function untar(tgz: Buffer): Record<string, string> {
	const tar = gunzipSync(tgz);
	const out: Record<string, string> = {};
	for (let off = 0; off + 512 <= tar.length; ) {
		const head = tar.subarray(off, off + 512);
		if (head.every((b) => b === 0)) break;
		const name = head.subarray(0, 100).toString("ascii").replace(/\0.*$/, "");
		const size = parseInt(head.subarray(124, 136).toString("ascii").replace(/\0.*$/, ""), 8);
		const stored = parseInt(head.subarray(148, 156).toString("ascii").replace(/[\0 ].*$/, ""), 8);
		const copy = Buffer.from(head);
		copy.fill(0x20, 148, 156);
		expect(copy.reduce((s, b) => s + b, 0)).toBe(stored);
		out[name] = tar.subarray(off + 512, off + 512 + size).toString("utf8");
		off += 512 + Math.ceil(size / 512) * 512;
	}
	return out;
}

type RegistryOpts = {
	existing?: Record<string, unknown>;
	/** Codes the registry accepts; each works once. */
	otps?: string[];
	trustStatus?: number;
	publishStatus?: number;
	lookupStatus?: number;
};

function fakeRegistry(opts: RegistryOpts = {}) {
	const packages = new Map<string, any>(Object.entries(opts.existing ?? {}));
	const valid = [...(opts.otps ?? [OTP])];
	const trust: any[] = [];
	const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: any }> = [];
	const otpRefused = () => ({ status: 401, headers: { get: (n: string) => (n === "www-authenticate" ? "OTP" : null) }, text: async () => '{"error":"You must provide a one-time pass."}' });
	const reply = (status: number, body: unknown) => ({ status, headers: { get: () => null }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
	const fetch = vi.fn<FetchLike>(async (url, init) => {
		calls.push({ method: init.method, url, headers: init.headers, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
		expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
		const path = new URL(url).pathname;
		const useOtp = () => {
			const code = init.headers["npm-otp"];
			const at = code ? valid.indexOf(code) : -1;
			if (at === -1) return false;
			valid.splice(at, 1);
			return true;
		};
		if (init.method === "GET" && path === `/${escapePackageName(PKG)}`) {
			if (opts.lookupStatus) return reply(opts.lookupStatus, { error: "boom" });
			const p = packages.get(PKG);
			return p ? reply(200, p) : reply(404, { error: "Not found" });
		}
		if (init.method === "PUT" && path === `/${escapePackageName(PKG)}`) {
			if (!useOtp()) return otpRefused();
			if (opts.publishStatus) return reply(opts.publishStatus, { error: "You do not have permission to publish" });
			const doc = JSON.parse(init.body!);
			packages.set(PKG, { name: doc.name, versions: doc.versions, "dist-tags": doc["dist-tags"] });
			return reply(200, { ok: true });
		}
		if (init.method === "POST" && path === `/-/package/${escapePackageName(PKG)}/trust`) {
			if (!useOtp()) return otpRefused();
			if (opts.trustStatus) return reply(opts.trustStatus, { error: "conflict" });
			const body = JSON.parse(init.body!);
			trust.push(...body);
			return reply(201, body.map((b: any, i: number) => ({ ...b, id: `trust-${i + 1}` })));
		}
		throw new Error(`unexpected ${init.method} ${url}`);
	});
	return { registry: new NpmRegistry({ token: TOKEN, fetch }), fetch, calls, packages, trust };
}

type RepoOpts = { private?: boolean; archived?: boolean; pkg?: unknown; pkgRaw?: string; workflow?: boolean; missing?: boolean; pkgIsDir?: boolean; plainEncoding?: boolean; bareRepo?: boolean };

function fakeGitHub(o: RepoOpts = {}) {
	const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
	const file = (s: string) => (o.plainEncoding ? { data: { type: "file", encoding: "utf-8", content: s } } : { data: { type: "file", encoding: "base64", content: Buffer.from(s).toString("base64") } });
	const request = vi.fn(async (route: string, p: any) => {
		if (route === "GET /repos/{owner}/{repo}") {
			if (o.missing) throw notFound();
			if (o.bareRepo) return { data: { private: false } };
			return { data: { full_name: "CLDMV/new-thing", private: o.private ?? false, archived: o.archived ?? false, default_branch: "master" } };
		}
		if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
			expect(p.ref).toBe(o.bareRepo ? "HEAD" : "master");
			if (p.path === "package.json") {
				if (o.pkgIsDir) return { data: [{ type: "file", name: "x" }] };
				if (o.pkg === undefined && o.pkgRaw === undefined) return file(JSON.stringify({ name: PKG, license: "Apache-2.0", description: "A new thing." }));
				if (o.pkg === null) throw notFound();
				return file(o.pkgRaw ?? JSON.stringify(o.pkg));
			}
			if (p.path === ".github/workflows/publish.yml" || p.path === ".github/workflows/release.yaml") {
				if (o.workflow === false) throw notFound();
				return file("name: publish\n");
			}
			throw notFound();
		}
		throw new Error(`unexpected route ${route}`);
	});
	return { octokit: { request } as any, request };
}

const args = (extra: Record<string, unknown> = {}) => ({ owner: "cldmv", repo: "new-thing", package: PKG, otp: OTP, ...extra });
const deps = (gh: ReturnType<typeof fakeGitHub>, reg: ReturnType<typeof fakeRegistry>, scopes = ["@cldmv"]) => ({ octokit: gh.octokit, registry: reg.registry, scopes });

describe("buildTarball", () => {
	it("writes package/-prefixed ustar entries with valid checksums, gzipped", () => {
		const files = untar(buildTarball([{ path: "package.json", content: '{"name":"x"}' }, { path: "README.md", content: "# x\n".repeat(200) }]));
		expect(Object.keys(files)).toEqual(["package/package.json", "package/README.md"]);
		expect(files["package/package.json"]).toBe('{"name":"x"}');
		expect(files["package/README.md"]).toBe("# x\n".repeat(200));
	});

	it("is reproducible (fixed mtime)", () => {
		const f = [{ path: "a.txt", content: "a" }];
		expect(buildTarball(f).equals(buildTarball(f))).toBe(true);
	});

	it("refuses paths it cannot store", () => {
		expect(() => buildTarball([{ path: "x".repeat(100), content: "" }])).toThrow(/unsupported path/);
		expect(() => buildTarball([{ path: "naïve.txt", content: "" }])).toThrow(/unsupported path/);
	});

	it("computes the sha512 integrity and sha1 shasum of the tarball", () => {
		const tgz = buildTarball([{ path: "a", content: "a" }]);
		const d = tarballDigests(tgz);
		expect(d.integrity).toBe(`sha512-${createHash("sha512").update(tgz).digest("base64")}`);
		expect(d.shasum).toBe(createHash("sha1").update(tgz).digest("hex"));
	});
});

describe("placeholderDocument", () => {
	it("builds the first-publish document with a marked placeholder manifest and matching tarball", () => {
		const doc = placeholderDocument(PKG, { repository: "CLDMV/new-thing", isPrivate: false, license: "Apache-2.0" }, "public", "https://registry.npmjs.org");
		expect(doc["dist-tags"]).toEqual({ latest: PLACEHOLDER_VERSION });
		expect(doc.access).toBe("public");
		const v = doc.versions[PLACEHOLDER_VERSION]!;
		expect(v.scaffoldedBy).toBe(SCAFFOLD_MARKER);
		expect(v.license).toBe("Apache-2.0");
		expect(v.repository).toEqual({ type: "git", url: "git+https://github.com/CLDMV/new-thing.git" });
		expect(v.dist.tarball).toBe(`https://registry.npmjs.org/${PKG}/-/new-thing-${PLACEHOLDER_VERSION}.tgz`);
		const att = doc._attachments[`${PKG}-${PLACEHOLDER_VERSION}.tgz`]!;
		const tgz = Buffer.from(att.data, "base64");
		expect(att.length).toBe(tgz.length);
		expect(v.dist.integrity).toBe(tarballDigests(tgz).integrity);
		const files = untar(tgz);
		expect(JSON.parse(files["package/package.json"]!)).toMatchObject({ name: PKG, version: PLACEHOLDER_VERSION, scaffoldedBy: SCAFFOLD_MARKER });
		expect(files["package/README.md"]).toContain("https://github.com/CLDMV/new-thing");
		// Only the two broker-built files: nothing else ships.
		expect(Object.keys(files)).toEqual(["package/package.json", "package/README.md"]);
	});

	it("falls back to UNLICENSED when the repo names no license", () => {
		const doc = placeholderDocument(PKG, { repository: "CLDMV/new-thing", isPrivate: true }, "restricted", "https://registry.npmjs.org");
		expect(doc.versions[PLACEHOLDER_VERSION]!.license).toBe("UNLICENSED");
		expect(doc.access).toBe("restricted");
	});
});

describe("npm_scaffold", () => {
	it("advertises a strict schema", () => {
		expect(NPM_SCAFFOLD_SCHEMA.required).toEqual(["owner", "repo", "package", "otp"]);
		expect(NPM_SCAFFOLD_SCHEMA.additionalProperties).toBe(false);
	});

	it("publishes the placeholder, then adds the trusted publisher on a second call with the next code", async () => {
		const reg = fakeRegistry({ otps: [OTP, OTP2] });
		const first = await npmScaffold(args(), deps(fakeGitHub(), reg));
		expect(first).toMatchObject({ status: "needs_otp", done: ["publish"], remaining: ["trust"], access: "public", repository: "CLDMV/new-thing", version: PLACEHOLDER_VERSION });
		expect(first.message).toMatch(/needs its own one-time password/);
		// The spent code is never sent again: no trust request on the first call.
		expect(reg.calls.filter((c) => c.url.endsWith("/trust"))).toHaveLength(0);
		const put = reg.calls.find((c) => c.method === "PUT")!;
		expect(put.headers["npm-otp"]).toBe(OTP);
		expect(put.body.access).toBe("public");

		const second = await npmScaffold(args({ otp: OTP2 }), deps(fakeGitHub(), reg));
		expect(second).toMatchObject({ status: "done", done: ["trust"], skipped: ["publish"], workflow: "publish.yml", trustId: "trust-1" });
		expect(second.url).toBe(`https://www.npmjs.com/package/${PKG}`);
		expect(reg.trust).toEqual([{ type: "github", claims: { repository: "CLDMV/new-thing", workflow_ref: { file: "publish.yml" } }, permissions: ["createPackage"] }]);
		expect(reg.calls.find((c) => c.url.endsWith("/trust"))!.headers["npm-otp"]).toBe(OTP2);
		expect(reg.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
	});

	it("uses restricted access for a private repo", async () => {
		const reg = fakeRegistry({ otps: [OTP] });
		const out = await npmScaffold(args(), deps(fakeGitHub({ private: true }), reg));
		expect(out.access).toBe("restricted");
		expect(reg.calls.find((c) => c.method === "PUT")!.body.access).toBe("restricted");
	});

	it("returns needs_otp when the trust code is refused, and finishes with a new one", async () => {
		const reg = fakeRegistry({ otps: [OTP, OTP2] });
		await npmScaffold(args(), deps(fakeGitHub(), reg));
		const refused = await npmScaffold(args({ otp: "999999" }), deps(fakeGitHub(), reg));
		expect(refused).toMatchObject({ status: "needs_otp", done: [], skipped: ["publish"], remaining: ["trust"] });
		expect(refused.message).toMatch(/refused the one-time password for the trusted publisher/);
		const done = await npmScaffold(args({ otp: OTP2 }), deps(fakeGitHub(), reg));
		expect(done).toMatchObject({ status: "done", done: ["trust"] });
	});

	it("returns needs_otp with nothing written when the code is refused before publishing", async () => {
		const reg = fakeRegistry({ otps: [] });
		const out = await npmScaffold(args(), deps(fakeGitHub(), reg));
		expect(out).toMatchObject({ status: "needs_otp", done: [], remaining: ["publish", "trust"] });
		expect(reg.packages.size).toBe(0);
	});

	it("treats an already-configured trusted publisher as done without failing", async () => {
		const doc = placeholderDocument(PKG, { repository: "CLDMV/new-thing", isPrivate: false }, "public", "https://registry.npmjs.org");
		const reg = fakeRegistry({ existing: { [PKG]: { name: PKG, versions: doc.versions } }, otps: [OTP], trustStatus: 409 });
		const out = await npmScaffold(args(), deps(fakeGitHub(), reg));
		expect(out).toMatchObject({ status: "done", done: [], skipped: ["publish", "trust"] });
	});

	it("refuses a package that already exists and was not created by npm_scaffold", async () => {
		const reg = fakeRegistry({ existing: { [PKG]: { name: PKG, versions: { "1.0.0": {}, "1.1.0": {} } } } });
		await expect(npmScaffold(args(), deps(fakeGitHub(), reg))).rejects.toThrow(/already exists on the registry \(2 version\(s\)\) and was not created by npm_scaffold/);
		expect(reg.calls.every((c) => c.method === "GET")).toBe(true);
	});

	it("refuses an existing single 0.0.0-stage version that lacks the scaffold marker", async () => {
		const reg = fakeRegistry({ existing: { [PKG]: { name: PKG, versions: { [PLACEHOLDER_VERSION]: { name: PKG } } } } });
		await expect(npmScaffold(args(), deps(fakeGitHub(), reg))).rejects.toThrow(/was not created by npm_scaffold/);
	});

	it("refuses a scope that is not configured, before any request", async () => {
		const gh = fakeGitHub();
		const reg = fakeRegistry();
		await expect(npmScaffold(args({ package: "@other/new-thing" }), deps(gh, reg))).rejects.toThrow(/scope @other is not in config\.npm\.scopes/);
		expect(gh.request).not.toHaveBeenCalled();
		expect(reg.fetch).not.toHaveBeenCalled();
	});

	it.each([
		[{ missing: true }, /repository cldmv\/new-thing not found/],
		[{ archived: true }, /is archived/],
		[{ pkg: null }, /has no package\.json on master/],
		[{ pkgRaw: "{nope" }, /is not valid JSON/],
		[{ pkg: { name: "@cldmv/other" } }, /names "@cldmv\/other", not "@cldmv\/new-thing"/],
		[{ pkg: { name: PKG, private: true } }, /marked "private": true/],
		[{ workflow: false }, /has no \.github\/workflows\/publish\.yml/]
	] as Array<[RepoOpts, RegExp]>)("refuses when the repo does not match (%o) without touching npm", async (repo, msg) => {
		const reg = fakeRegistry();
		await expect(npmScaffold(args(), deps(fakeGitHub(repo), reg))).rejects.toThrow(msg);
		expect(reg.fetch).not.toHaveBeenCalled();
	});

	it("treats a package.json that is not a file as missing", async () => {
		await expect(npmScaffold(args(), deps(fakeGitHub({ pkgIsDir: true }), fakeRegistry()))).rejects.toThrow(/has no package\.json/);
	});

	it("reads repo files that are not base64-encoded", async () => {
		const out = await npmScaffold(args(), deps(fakeGitHub({ plainEncoding: true }), fakeRegistry()));
		expect(out).toMatchObject({ status: "needs_otp", done: ["publish"] });
	});

	it("falls back to owner/repo and HEAD when GitHub omits full_name and default_branch, and to no license or description", async () => {
		const reg = fakeRegistry();
		const gh = fakeGitHub({ bareRepo: true, pkg: { name: PKG } });
		const out = await npmScaffold(args(), deps(gh, reg));
		expect(out.repository).toBe("cldmv/new-thing");
		const v = reg.calls.find((c) => c.method === "PUT")!.body.versions[PLACEHOLDER_VERSION];
		expect(v.license).toBe("UNLICENSED");
		expect(v.readme).not.toContain("undefined");
	});

	it("refuses an existing package document that lists no versions", async () => {
		const reg = fakeRegistry({ existing: { [PKG]: { name: PKG } } });
		await expect(npmScaffold(args(), deps(fakeGitHub(), reg))).rejects.toThrow(/\(0 version\(s\)\) and was not created by npm_scaffold/);
	});

	it("honours a custom workflow file name", async () => {
		const reg = fakeRegistry({ otps: [OTP, OTP2] });
		await npmScaffold(args({ workflow: "release.yaml" }), deps(fakeGitHub(), reg));
		const out = await npmScaffold(args({ workflow: "release.yaml", otp: OTP2 }), deps(fakeGitHub(), reg));
		expect(out.workflow).toBe("release.yaml");
		expect(reg.trust[0].claims.workflow_ref.file).toBe("release.yaml");
	});

	it.each([
		[null, /arguments must be an object/],
		[{ ...args(), extra: 1 }, /unknown argument\(s\): extra/],
		[{ ...args(), owner: "bad/owner" }, /"owner"/],
		[{ ...args(), repo: "../x" }, /"repo"/],
		[{ ...args(), package: "unscoped" }, /"package"/],
		[{ ...args(), package: "@CLDMV/Upper" }, /"package"/],
		[{ ...args(), otp: "12ab56" }, /"otp"/],
		[{ ...args(), otp: 123456 }, /"otp"/],
		[{ ...args(), workflow: "../publish.yml" }, /"workflow"/],
		[{ ...args(), workflow: "publish.sh" }, /"workflow"/]
	] as Array<[unknown, RegExp]>)("validates arguments strictly (%#)", async (input, msg) => {
		const gh = fakeGitHub();
		await expect(npmScaffold(input, deps(gh, fakeRegistry()))).rejects.toThrow(msg);
		expect(gh.request).not.toHaveBeenCalled();
	});

	it("never puts the OTP or the token in a result or an error", async () => {
		const ok = await npmScaffold(args(), deps(fakeGitHub(), fakeRegistry({ otps: [OTP] })));
		const needs = await npmScaffold(args(), deps(fakeGitHub(), fakeRegistry({ otps: [] })));
		const errors: string[] = [];
		for (const reg of [fakeRegistry({ publishStatus: 403 }), fakeRegistry({ lookupStatus: 500 })]) {
			await npmScaffold(args(), deps(fakeGitHub(), reg)).catch((e: Error) => errors.push(e.message));
		}
		await npmScaffold({ ...args(), otp: "12345x" }, deps(fakeGitHub(), fakeRegistry())).catch((e: Error) => errors.push(e.message));
		expect(errors).toHaveLength(3);
		for (const text of [JSON.stringify(ok), JSON.stringify(needs), ...errors]) {
			expect(text).not.toContain(OTP);
			expect(text).not.toContain("12345x");
			expect(text).not.toContain(TOKEN);
		}
	});

	it("passes GitHub errors other than 404 through unchanged", async () => {
		const boom = Object.assign(new Error("rate limited"), { status: 403 });
		for (const route of ["GET /repos/{owner}/{repo}", "GET /repos/{owner}/{repo}/contents/{path}"]) {
			const gh = fakeGitHub();
			const real = gh.request.getMockImplementation()!;
			gh.request.mockImplementation(async (r: string, p: any) => {
				if (r === route) throw boom;
				return real(r, p);
			});
			await expect(npmScaffold(args(), deps(gh, fakeRegistry()))).rejects.toBe(boom);
		}
	});

	it("passes a trust failure that is not an OTP refusal through, after the publish", async () => {
		const reg = fakeRegistry({ otps: [OTP, OTP2], trustStatus: 400 });
		await npmScaffold(args(), deps(fakeGitHub(), reg));
		await expect(npmScaffold(args({ otp: OTP2 }), deps(fakeGitHub(), reg))).rejects.toThrow(/trusted publisher setup failed \(HTTP 400\)/);
		expect(reg.packages.has(PKG)).toBe(true);
	});

	it("surfaces a registry refusal as an HTTP error with npm's message", async () => {
		await expect(npmScaffold(args(), deps(fakeGitHub(), fakeRegistry({ publishStatus: 403 })))).rejects.toThrow(/npm: publish failed \(HTTP 403\): You do not have permission to publish/);
	});
});

describe("NpmRegistry", () => {
	const res = (status: number, body: string, headers: Record<string, string> = {}) => ({ status, headers: { get: (n: string) => headers[n] ?? null }, text: async () => body });

	it("detects an OTP refusal from the body when the header does not say so", async () => {
		const reg = new NpmRegistry({ token: TOKEN, fetch: async () => res(401, "This operation requires a one-time password") });
		await expect(reg.publish({}, PKG, OTP)).rejects.toBeInstanceOf(NpmOtpRequired);
	});

	it("treats a plain 401 as an HTTP error, not an OTP request", async () => {
		const reg = new NpmRegistry({ token: TOKEN, fetch: async () => res(401, '{"error":"bad token"}') });
		await expect(reg.publish({}, PKG, OTP)).rejects.toBeInstanceOf(NpmHttpError);
	});

	it("trims a trailing slash from the registry and reports a non-JSON error body", async () => {
		const seen: string[] = [];
		const reg = new NpmRegistry({ token: TOKEN, registry: "https://npm.example.test/", fetch: async (url) => (seen.push(url), res(502, "Bad Gateway")) });
		await expect(reg.packument(PKG)).rejects.toThrow(/package lookup failed \(HTTP 502\): Bad Gateway/);
		expect(seen).toEqual([`https://npm.example.test/${escapePackageName(PKG)}`]);
		expect(reg.registry).toBe("https://npm.example.test");
	});

	it("accepts a trust response that is not JSON", async () => {
		const reg = new NpmRegistry({ token: TOKEN, fetch: async () => res(204, "") });
		await expect(reg.addGithubTrust(PKG, { repository: "CLDMV/x", file: "publish.yml" }, OTP)).resolves.toEqual({ alreadyExists: false });
	});

	it("reports an HTTP error with an empty body by status alone", async () => {
		const reg = new NpmRegistry({ token: TOKEN, fetch: async () => res(500, "") });
		await expect(reg.packument(PKG)).rejects.toThrow(/^npm: package lookup failed \(HTTP 500\)$/);
	});

	it("takes the trust config from an object response, and none from an empty or non-object one", async () => {
		const claims = { repository: "CLDMV/x", file: "publish.yml" };
		const one = new NpmRegistry({ token: TOKEN, fetch: async () => res(201, '{"id":"t-9","type":"github"}') });
		await expect(one.addGithubTrust(PKG, claims, OTP)).resolves.toEqual({ config: { id: "t-9", type: "github" }, alreadyExists: false });
		for (const body of ["[]", '"ok"']) {
			const reg = new NpmRegistry({ token: TOKEN, fetch: async () => res(201, body) });
			await expect(reg.addGithubTrust(PKG, claims, OTP)).resolves.toEqual({ config: undefined, alreadyExists: false });
		}
	});

	it("fails a trust setup the registry rejects", async () => {
		const reg = new NpmRegistry({ token: TOKEN, fetch: async () => res(400, '{"message":"workflow not found"}') });
		await expect(reg.addGithubTrust(PKG, { repository: "CLDMV/x", file: "publish.yml" }, OTP)).rejects.toThrow(/trusted publisher setup failed \(HTTP 400\): workflow not found/);
	});
});
