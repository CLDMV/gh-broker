import { describe, it, expect, vi } from "vitest";
import { reportDependents, isBehind, REPORT_DEPENDENTS_SCHEMA } from "../src/verbs/report_dependents.ts";
import { latestVersion } from "../src/verbs/npm-registry.ts";

const NAME = "@cldmv/fix-headers";

const status = (code: number, message = "x") => Object.assign(new Error(message), { status: code });
const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64");
const file = (v: unknown) => ({ data: { size: 100, content: b64(v) }, headers: {} });

interface FakeRepo {
	info?: Record<string, unknown> | "gone";
	files?: Record<string, unknown>;
	/** Files that are 1 MB+: the API gives metadata only, then the raw body. */
	big?: Record<string, string>;
	/** Files reported over the byte cap. */
	huge?: string[];
	/** A workflow file exists, so the repo classifies as v4. */
	v4?: boolean;
	/** A `dev` branch: its files (read with ref `dev`), and the root versions the GraphQL listing returns. */
	dev?: { files?: Record<string, unknown>; same?: boolean; truncated?: boolean; version?: string; defaultVersion?: string; manifestText?: string | null };
	/** Listed by GraphQL but archived / a fork / without a default branch. */
	gql?: Record<string, unknown>;
}

const blob = (version: string | undefined, text?: string | null) => ({ oid: "x", file: text !== undefined ? { object: { text } } : version === undefined ? null : { object: { text: JSON.stringify({ version }) } } });

/** The GraphQL dev-branch listing for `repos`, split into pages of `pageSize`. */
function devNodes(repos: Record<string, FakeRepo>) {
	return Object.entries(repos)
		.filter(([, r]) => r.info !== "gone")
		.map(([name, r]) => ({
			name,
			isArchived: false,
			isFork: false,
			isPrivate: false,
			defaultBranchRef: { name: "master", target: { ...blob(r.dev?.defaultVersion), oid: "m" } },
			dev: r.dev ? { target: { ...blob(r.dev.version, r.dev.manifestText), oid: r.dev.same ? "m" : "d" } } : null,
			...r.gql
		}));
}

/** A fake GitHub: code search over `hits`, and per-repo info/contents/branches. */
function fakeGithub(hits: [string, string][], repos: Record<string, FakeRepo>, search: Record<string, unknown> = {}) {
	const request = vi.fn(async (route: string, p: any) => {
		if (route === "GET /search/code") {
			const items = hits.map(([repo, path]) => ({ path, repository: { name: repo, owner: { login: "CLDMV" } } }));
			return { data: { total_count: items.length, incomplete_results: false, items, ...search }, headers: { "x-ratelimit-limit": "10", "x-ratelimit-remaining": "9" } };
		}
		if (route === "POST /graphql") {
			return { data: { data: { repositoryOwner: { repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: devNodes(repos) } } } }, headers: {} };
		}
		const r = repos[p.repo];
		if (!r || r.info === "gone") throw status(404);
		if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
			const tree = [...Object.keys(r.dev?.files ?? {}), "node_modules/x/package.json", "src"].map((path) => ({ path, type: path === "src" ? "tree" : "blob" }));
			return { data: { truncated: r.dev?.truncated ?? false, tree }, headers: {} };
		}
		if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "master", private: false, ...r.info }, headers: {} };
		if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
			if (p.path === ".github/workflows/next-release.yml") {
				if (!r.v4) throw status(404);
				return { data: {}, headers: {} };
			}
			if (p.ref === "dev") {
				if (r.dev?.files && p.path in r.dev.files) return file(r.dev.files[p.path]);
				throw status(404);
			}
			if (r.huge?.includes(p.path)) return { data: { size: 99_000_000 }, headers: {} };
			if (r.big && p.path in r.big) return p.headers ? { data: r.big[p.path], headers: {} } : { data: { size: 2_000_000, content: "" }, headers: {} };
			if (r.files && p.path in r.files) return file(r.files[p.path]);
			throw status(404);
		}
		if (route === "GET /repos/{owner}/{repo}/branches/{branch}") {
			if (p.branch === "dev" && !r.dev) throw status(404);
			// A repo with a dev branch is scaffold-only on next (next == master), i.e. dev-trunk.
			const sha = p.branch === "dev" ? "d" : p.branch === "next" && !r.dev ? "n" : "m";
			return { data: { commit: { sha } }, headers: {} };
		}
		throw new Error(`unexpected route ${route}`);
	});
	return { request } as any;
}

const manifest = (over: Record<string, unknown>) => ({ name: "x", ...over });

describe("reportDependents — discovery and verification", () => {
	it("searches the org once for the package name in package.json files and reports each declaring field", async () => {
		const gh = fakeGithub(
			[
				["a", "package.json"],
				["b", "package.json"],
				["c", "package.json"]
			],
			{
				a: { files: { "package.json": manifest({ devDependencies: { [NAME]: "^1.2.0" } }) }, v4: true },
				b: { files: { "package.json": manifest({ dependencies: { [NAME]: "^1.0.0" }, peerDependencies: { [NAME]: ">=1" } }) } },
				c: { files: { "package.json": manifest({ description: `mentions ${NAME} only in text` }) } }
			}
		);
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME });
		expect(gh.request.mock.calls[0]).toEqual(["GET /search/code", { q: `"${NAME}" org:CLDMV filename:package.json`, per_page: 100, page: 1 }]);
		expect(out.scanned).toEqual({ candidates: 3, archived: 0, forks: 0, missing: 0, notDeclared: 1, devBranches: 0 });
		expect(out.discovery).toMatchObject({ source: "code-search", devBranches: true });
		expect(out.discovery.note).toMatch(/lags/);
		expect(out.discovery.note).toMatch(/dev-trunk repos are included/);
		expect(out.dependents).toEqual([
			{
				repo: "CLDMV/a",
				private: false,
				defaultBranch: "master",
				branch: "master",
				tier: "v4",
				tierSignals: expect.objectContaining({ v4Workflow: true }),
				declarations: [{ path: "package.json", declared: [{ field: "devDependencies", range: "^1.2.0" }] }]
			},
			{
				repo: "CLDMV/b",
				private: false,
				defaultBranch: "master",
				branch: "master",
				tier: "non-v4",
				tierSignals: { v4Workflow: false, defaultBranch: "master" },
				declarations: [
					{
						path: "package.json",
						declared: [
							{ field: "dependencies", range: "^1.0.0" },
							{ field: "peerDependencies", range: ">=1" }
						]
					}
				]
			}
		]);
		expect(out.truncated).toBeUndefined();
	});

	it("rejects a package name that is not a valid npm name before searching", async () => {
		const gh = fakeGithub([], {});
		await expect(reportDependents(gh, { owner: "CLDMV", name: 'x" org:other' })).rejects.toThrow(/not a valid npm package name/);
		expect(gh.request).not.toHaveBeenCalled();
	});

	it("skips archived repos and forks, and counts repos that vanished since the search", async () => {
		const m = { files: { "package.json": manifest({ dependencies: { [NAME]: "1.0.0" } }) } };
		const gh = fakeGithub(
			[
				["arch", "package.json"],
				["fork", "package.json"],
				["gone", "package.json"],
				["ok", "package.json"]
			],
			{ arch: { ...m, info: { archived: true } }, fork: { ...m, info: { fork: true } }, gone: { info: "gone" }, ok: m }
		);
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME, classify: false });
		expect(out.scanned).toMatchObject({ candidates: 4, archived: 1, forks: 1, missing: 1 });
		expect(out.dependents.map((d) => d.repo)).toEqual(["CLDMV/ok"]);
		expect(out.dependents[0]).not.toHaveProperty("tier");
	});

	it("ignores search hits that are not a package.json and reports private visibility", async () => {
		const gh = fakeGithub(
			[
				["a", "my-package.json"],
				["p", "package.json"]
			],
			{ p: { info: { private: true }, files: { "package.json": manifest({ dependencies: { [NAME]: "1.0.0" } }) } } }
		);
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME, classify: false });
		expect(out.scanned.candidates).toBe(1);
		expect(out.dependents[0]).toMatchObject({ repo: "CLDMV/p", private: true });
	});

	it("treats a repo with no info.private flag as public", async () => {
		const gh = fakeGithub([["p", "package.json"]], { p: { info: { private: undefined }, files: { "package.json": manifest({ dependencies: { [NAME]: "1" } }) } } });
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME, classify: false });
		expect(out.dependents[0]!.private).toBe(false);
	});

	it("lists unreadable manifests (missing, too large, invalid JSON) instead of failing", async () => {
		const gh = fakeGithub(
			[
				["a", "package.json"],
				["a", "packages/gone/package.json"],
				["a", "packages/huge/package.json"],
				["a", "packages/bad/package.json"]
			],
			{ a: { files: { "packages/bad/package.json": "{nope" }, huge: ["packages/huge/package.json"] } }
		);
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME, maxFileBytes: 1000 });
		expect(out.dependents).toEqual([
			{
				repo: "CLDMV/a",
				private: false,
				defaultBranch: "master",
				branch: "master",
				declarations: [],
				unread: [
					{ path: "package.json", reason: "missing" },
					{ path: "packages/bad/package.json", reason: "invalid-json" },
					{ path: "packages/gone/package.json", reason: "missing" },
					{ path: "packages/huge/package.json", reason: "too-large" }
				]
			}
		]);
	});

	it("rethrows an unexpected error from reading the repo or a file", async () => {
		const bad = { request: vi.fn(async (route: string) => (route === "GET /search/code" ? { data: { total_count: 1, incomplete_results: false, items: [{ path: "package.json", repository: { name: "a" } }] }, headers: {} } : Promise.reject(status(500)))) } as any;
		await expect(reportDependents(bad, { owner: "CLDMV", name: NAME })).rejects.toMatchObject({ status: 500 });
		const bad2 = fakeGithub([["a", "package.json"]], { a: { files: {} } });
		const orig = bad2.request.getMockImplementation()!;
		bad2.request.mockImplementation(async (route: string, p: any) => {
			if (route.endsWith("/contents/{path}")) throw status(500);
			return orig(route, p);
		});
		await expect(reportDependents(bad2, { owner: "CLDMV", name: NAME })).rejects.toMatchObject({ status: 500 });
	});
});

describe("reportDependents — lockfile resolution", () => {
	const lockV3 = {
		packages: {
			"": {},
			"node_modules/@cldmv/fix-headers": { version: "1.4.0" },
			"packages/app/node_modules/@cldmv/fix-headers": { version: "1.2.0" }
		}
	};

	it("resolves root and workspace-member versions from package-lock.json, preferring the member's own node_modules", async () => {
		const gh = fakeGithub(
			[
				["w", "package.json"],
				["w", "packages/app/package.json"],
				["w", "packages/lib/package.json"]
			],
			{
				w: {
					files: {
						"package.json": manifest({ devDependencies: { [NAME]: "^1.4.0" } }),
						"packages/app/package.json": manifest({ dependencies: { [NAME]: "^1.2.0" } }),
						"packages/lib/package.json": manifest({ dependencies: { [NAME]: "^1.0.0" } }),
						"package-lock.json": lockV3
					}
				}
			}
		);
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME, classify: false });
		const w = out.dependents[0]!;
		expect(w.lockfile).toBe("package-lock.json");
		expect(w.declarations.map((d) => [d.path, d.member, d.resolved])).toEqual([
			["package.json", undefined, "1.4.0"],
			["packages/app/package.json", "packages/app", "1.2.0"],
			["packages/lib/package.json", "packages/lib", "1.4.0"]
		]);
	});

	it("falls back to the v1 lockfile `dependencies` map and leaves resolved off when the lockfile lacks the package", async () => {
		const gh = fakeGithub(
			[
				["v1", "package.json"],
				["none", "package.json"]
			],
			{
				v1: { files: { "package.json": manifest({ dependencies: { [NAME]: "1" } }), "package-lock.json": { dependencies: { [NAME]: { version: "1.1.1" } } } } },
				none: { files: { "package.json": manifest({ dependencies: { [NAME]: "1" } }), "package-lock.json": { packages: {} } } }
			}
		);
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME, classify: false });
		const byRepo = Object.fromEntries(out.dependents.map((d) => [d.repo, d]));
		expect(byRepo["CLDMV/v1"]!.declarations[0]!.resolved).toBe("1.1.1");
		expect(byRepo["CLDMV/none"]!.declarations[0]).not.toHaveProperty("resolved");
	});

	const pnpm = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      '@cldmv/fix-headers':
        specifier: ^1.4.0
        version: 1.4.2(typescript@5.0.0)
      other:
        specifier: ^1
        version: 9.9.9

  packages/app:
    dependencies:
      other:
        specifier: ^1
        version: 9.9.9
      "@cldmv/fix-headers":
        specifier: ^1.2.0
        version: 1.2.3

  'packages/linked':
    dependencies:
      '@cldmv/fix-headers':
        specifier: workspace:*
        version: link:../fix-headers

packages:

  '@cldmv/fix-headers@1.4.2':
    resolution: {integrity: sha512-x}
`;

	it("resolves versions from pnpm-lock.yaml importers, stripping peer suffixes and ignoring links", async () => {
		const gh = fakeGithub(
			[
				["p", "package.json"],
				["p", "packages/app/package.json"],
				["p", "packages/linked/package.json"],
				["p", "packages/missing/package.json"]
			],
			{
				p: {
					files: {
						"package.json": manifest({ devDependencies: { [NAME]: "^1.4.0" } }),
						"packages/app/package.json": manifest({ dependencies: { [NAME]: "^1.2.0" } }),
						"packages/linked/package.json": manifest({ dependencies: { [NAME]: "workspace:*" } }),
						"packages/missing/package.json": manifest({ dependencies: { [NAME]: "^1" } }),
						"pnpm-lock.yaml": pnpm
					}
				}
			}
		);
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME, classify: false });
		const p = out.dependents[0]!;
		expect(p.lockfile).toBe("pnpm-lock.yaml");
		expect(p.declarations.map((d) => [d.path, d.resolved])).toEqual([["package.json", "1.4.2"], ["packages/app/package.json", "1.2.3"], ["packages/linked/package.json", undefined], ["packages/missing/package.json", undefined]]);
	});

	it("reads a lockfile the contents API leaves out (over 1 MB) through the raw media type", async () => {
		const gh = fakeGithub([["big", "package.json"]], {
			big: { files: { "package.json": manifest({ dependencies: { [NAME]: "1" } }) }, big: { "package-lock.json": JSON.stringify(lockV3) } }
		});
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME, classify: false });
		expect(out.dependents[0]!.declarations[0]!.resolved).toBe("1.4.0");
		expect(gh.request.mock.calls.some((c: any[]) => c[1].headers?.accept === "application/vnd.github.raw+json")).toBe(true);
	});

	it("lists a lockfile over the byte cap or with invalid JSON in `unread` and carries on", async () => {
		const gh = fakeGithub(
			[
				["huge", "package.json"],
				["bad", "package.json"]
			],
			{
				huge: { files: { "package.json": manifest({ dependencies: { [NAME]: "1" } }) }, huge: ["package-lock.json"] },
				bad: { files: { "package.json": manifest({ dependencies: { [NAME]: "1" } }), "package-lock.json": "{nope" } }
			}
		);
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME, classify: false });
		const [bad, huge] = out.dependents;
		expect(huge!.unread).toEqual([{ path: "package-lock.json", reason: "too-large" }]);
		expect(huge).not.toHaveProperty("lockfile");
		expect(bad!.unread).toEqual([{ path: "package-lock.json", reason: "invalid-json" }]);
		expect(bad).not.toHaveProperty("lockfile");
	});
});

describe("reportDependents — latest", () => {
	const fetchOf = (status: number, body: string) =>
		vi.fn(async (_url: string, _init: unknown) => ({ status, headers: { get: () => null }, text: async () => body })) as any;
	const gh = () =>
		fakeGithub(
			[
				["old", "package.json"],
				["cur", "package.json"]
			],
			{
				old: { files: { "package.json": manifest({ dependencies: { [NAME]: "^1" } }), "package-lock.json": { packages: { [`node_modules/${NAME}`]: { version: "1.4.0" } } } } },
				cur: { files: { "package.json": manifest({ dependencies: { [NAME]: "^1" } }), "package-lock.json": { packages: { [`node_modules/${NAME}`]: { version: "1.5.0" } } } } }
			}
		);

	it("marks resolved versions older than the latest published one", async () => {
		const fetch = fetchOf(200, '{"version":"1.5.0"}');
		const out = await reportDependents(gh(), { owner: "CLDMV", name: NAME, latest: true, classify: false }, { fetch });
		expect(fetch.mock.calls[0]![0]).toBe("https://registry.npmjs.org/@cldmv%2ffix-headers/latest");
		expect(out.latest).toBe("1.5.0");
		expect(out.dependents.map((d) => [d.repo, d.declarations[0]!.behind])).toEqual([
			["CLDMV/cur", false],
			["CLDMV/old", true]
		]);
	});

	it("uses a custom registry and reports a failed lookup without failing the verb", async () => {
		const fetch = fetchOf(500, '{"error":"boom"}');
		const out = await reportDependents(gh(), { owner: "CLDMV", name: NAME, latest: true, classify: false }, { fetch, registry: "https://npm.example.test/" });
		expect(fetch.mock.calls[0]![0]).toBe("https://npm.example.test/@cldmv%2ffix-headers/latest");
		expect(out.latestError).toMatch(/HTTP 500/);
		expect(out).not.toHaveProperty("latest");
		expect(out.dependents[0]!.declarations[0]).not.toHaveProperty("behind");
	});

	it("omits latest for an unpublished package", async () => {
		const out = await reportDependents(gh(), { owner: "CLDMV", name: NAME, latest: true, classify: false }, { fetch: fetchOf(404, "") });
		expect(out).not.toHaveProperty("latest");
		expect(out).not.toHaveProperty("latestError");
	});
});

describe("isBehind", () => {
	it("compares numeric parts, padding short versions", () => {
		expect(isBehind("1.4.0", "1.5.0")).toBe(true);
		expect(isBehind("1.5.0", "1.4.9")).toBe(false);
		expect(isBehind("2.0.0", "10.0.0")).toBe(true);
		expect(isBehind("1.2", "1.2.1")).toBe(true);
		expect(isBehind("1.2.0", "1.2")).toBe(false);
	});
	it("sorts a prerelease below its release and treats equal versions as current", () => {
		expect(isBehind("1.5.0-rc.1", "1.5.0")).toBe(true);
		expect(isBehind("1.5.0", "1.5.0-rc.1")).toBe(false);
		expect(isBehind("1.5.0", "1.5.0")).toBe(false);
		expect(isBehind("1.5.0-rc.1", "1.5.0-rc.2")).toBe(false);
	});
});

describe("latestVersion", () => {
	const fetchOf = (status: number, body: string) => vi.fn(async () => ({ status, headers: { get: () => null }, text: async () => body })) as any;

	it("reads the version from the registry's /latest document", async () => {
		expect(await latestVersion("left-pad", { fetch: fetchOf(200, '{"version":"1.3.0"}') })).toBe("1.3.0");
	});
	it("returns undefined for a 404 and throws for other failures or a document without a version", async () => {
		expect(await latestVersion("nope", { fetch: fetchOf(404, "") })).toBeUndefined();
		await expect(latestVersion("x", { fetch: fetchOf(503, "") })).rejects.toThrow(/HTTP 503/);
		await expect(latestVersion("x", { fetch: fetchOf(200, "{}") })).rejects.toThrow(/no version/);
	});
	it("falls back to global fetch and the default registry", async () => {
		const f = fetchOf(200, '{"version":"2.0.0"}');
		vi.stubGlobal("fetch", f);
		try {
			expect(await latestVersion("y")).toBe("2.0.0");
			expect(f.mock.calls[0][0]).toBe("https://registry.npmjs.org/y/latest");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("reportDependents — search paging and budgets", () => {
	it("pages through a full search page and flags max-results when GitHub's 1000-hit window is exhausted", async () => {
		const request = vi.fn(async (route: string, p: any) => {
			if (route === "GET /search/code") {
				const items = Array.from({ length: 100 }, (_, i) => ({ path: "package.json", repository: { name: `r${p.page}-${i}` } }));
				return { data: { total_count: 5000, incomplete_results: false, items }, headers: {} };
			}
			throw status(404);
		});
		const out = await reportDependents({ request } as any, { owner: "CLDMV", name: NAME, maxRepos: 2, devBranches: false });
		expect(request.mock.calls.filter((c) => c[0] === "GET /search/code")).toHaveLength(10);
		expect(out.scanned.candidates).toBe(1000);
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("max-results");
		expect(out.scanned.missing).toBe(2);
	});

	it("stops paging when the total is reached on a full last page without calling it truncated", async () => {
		const request = vi.fn(async (route: string, p: any) => {
			if (route === "GET /search/code") {
				const items = p.page === 1 ? Array.from({ length: 100 }, (_, i) => ({ path: "package.json", repository: { name: `r${i}` } })) : [];
				return { data: { total_count: 100, incomplete_results: false, items }, headers: {} };
			}
			throw status(404);
		});
		const out = await reportDependents({ request } as any, { owner: "CLDMV", name: NAME, maxRepos: 1, devBranches: false });
		expect(out.truncatedReason).toBe("max-repos");
		expect(request.mock.calls.filter((c) => c[0] === "GET /search/code")).toHaveLength(2);
	});

	it("reports an incomplete search", async () => {
		const gh = fakeGithub([], {}, { incomplete_results: true });
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME });
		expect(out).toMatchObject({ truncated: true, truncatedReason: "incomplete-search" });
	});

	it("returns what it verified with max-api-calls when the budget runs out", async () => {
		const m = { files: { "package.json": manifest({ dependencies: { [NAME]: "1" } }) } };
		const gh = fakeGithub(
			[
				["a", "package.json"],
				["b", "package.json"]
			],
			{ a: m, b: m }
		);
		// search 1 + repo 1 + manifest 1 + 2 lockfile misses = 5 calls for `a`; `b` runs dry.
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME, classify: false, maxApiCalls: 6 });
		expect(out.dependents.map((d) => d.repo)).toEqual(["CLDMV/a"]);
		expect(out).toMatchObject({ truncated: true, truncatedReason: "max-api-calls" });
	});

	it("stops with rate-limited, carrying Retry-After, when GitHub throttles mid-run", async () => {
		const request = vi.fn(async () => {
			throw Object.assign(new Error("Forbidden"), { status: 403, response: { headers: { "retry-after": "30" } } });
		});
		const out = await reportDependents({ request } as any, { owner: "CLDMV", name: NAME });
		expect(out).toMatchObject({ dependents: [], truncated: true, truncatedReason: "rate-limited", retryAfterSeconds: 30 });
	});

	it("rethrows an unexpected search failure", async () => {
		const request = vi.fn(async () => {
			throw status(500);
		});
		await expect(reportDependents({ request } as any, { owner: "CLDMV", name: NAME })).rejects.toMatchObject({ status: 500 });
	});

	it("clamps the caps to their hard limits", async () => {
		const gh = fakeGithub([], {});
		await reportDependents(gh, { owner: "CLDMV", name: NAME, maxRepos: 99999, maxFileBytes: 1e12, maxApiCalls: 1e9 });
		expect(gh.request.mock.calls.map((c: unknown[]) => c[0])).toEqual(["GET /search/code", "POST /graphql"]);
	});
});

describe("reportDependents — dev branches", () => {
	const dep = (range: string) => manifest({ devDependencies: { [NAME]: range } });

	it("reads every package.json on a separate dev branch, skipping node_modules, and resolves against dev's lockfile", async () => {
		const gh = fakeGithub([], {
			trunk: {
				v4: true,
				dev: {
					version: "0.4.0",
					defaultVersion: "0.0.0",
					files: {
						"package.json": dep("^1.5.0"),
						"packages/a/package.json": dep("^1.4.0"),
						"packages/b/package.json": manifest({}),
						"package-lock.json": { packages: { "node_modules/@cldmv/fix-headers": { version: "1.5.1" } } }
					}
				}
			},
			plain: { files: {} }
		});
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME });
		const graphql = gh.request.mock.calls.find((c: unknown[]) => c[0] === "POST /graphql");
		expect(graphql[1]).toMatchObject({ variables: { owner: "CLDMV", after: null } });
		expect(graphql[1].query).toMatch(/refs\/heads\/dev/);
		expect(gh.request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", { owner: "CLDMV", repo: "trunk", tree_sha: "dev", recursive: "1" });
		expect(out.scanned.devBranches).toBe(1);
		expect(out.dependents).toEqual([
			{
				repo: "CLDMV/trunk",
				private: false,
				defaultBranch: "master",
				branch: "dev",
				tier: "dev-trunk",
				tierSignals: expect.objectContaining({ dev: true }),
				lockfile: "package-lock.json",
				declarations: [
					{ path: "package.json", declared: [{ field: "devDependencies", range: "^1.5.0" }], resolved: "1.5.1" },
					{ path: "packages/a/package.json", member: "packages/a", declared: [{ field: "devDependencies", range: "^1.4.0" }], resolved: "1.5.1" }
				]
			}
		]);
		expect(out).not.toHaveProperty("abandonedDev");
	});

	it("reports a repo once per branch when both declare the package, classifying it once", async () => {
		const gh = fakeGithub([["both", "package.json"]], {
			both: { v4: true, files: { "package.json": dep("^1.0.0") }, dev: { files: { "package.json": dep("^1.5.0") } } }
		});
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME });
		expect(out.dependents.map((d) => [d.repo, d.branch])).toEqual([
			["CLDMV/both", "master"],
			["CLDMV/both", "dev"]
		]);
		expect(out.dependents[1]!.tier).toBe(out.dependents[0]!.tier);
		expect(gh.request.mock.calls.filter((c: unknown[]) => c[0] === "GET /repos/{owner}/{repo}/contents/{path}" && (c[1] as any).path === ".github/workflows/next-release.yml")).toHaveLength(1);
	});

	it("sorts default-branch entries before dev ones across repos", async () => {
		const gh = fakeGithub([["b", "package.json"]], {
			a: { dev: { files: { "package.json": dep("1") } } },
			b: { files: { "package.json": dep("1") }, dev: { files: { "package.json": dep("1") } } },
			c: { dev: { files: { "package.json": manifest({}) } } }
		});
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME, classify: false });
		expect(out.dependents.map((d) => `${d.repo}@${d.branch}`)).toEqual(["CLDMV/a@dev", "CLDMV/b@master", "CLDMV/b@dev"]);
	});

	it("treats a dev whose root version is below the default branch's as abandoned and skips it", async () => {
		const gh = fakeGithub([], {
			old: { dev: { version: "1.2.0", defaultVersion: "1.10.0", files: { "package.json": dep("1") } } },
			ahead: { dev: { version: "2.0.0-rc.1", defaultVersion: "1.10.0", files: { "package.json": dep("1") } } },
			noVersion: { dev: { defaultVersion: "1.0.0", files: { "package.json": dep("1") } } },
			badJson: { dev: { manifestText: "{nope", defaultVersion: "1.0.0", files: { "package.json": dep("1") } } },
			numeric: { dev: { manifestText: JSON.stringify({ version: 3 }), defaultVersion: "1.0.0", files: { "package.json": dep("1") } } },
			emptyText: { dev: { manifestText: null, defaultVersion: "1.0.0", files: { "package.json": dep("1") } } }
		});
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME, classify: false });
		expect(out.abandonedDev).toEqual([{ repo: "CLDMV/old", devVersion: "1.2.0", defaultVersion: "1.10.0" }]);
		expect(out.dependents.map((d) => d.repo).sort()).toEqual(["CLDMV/ahead", "CLDMV/badJson", "CLDMV/emptyText", "CLDMV/noVersion", "CLDMV/numeric"]);
		expect(out.scanned.devBranches).toBe(5);
	});

	it("skips dev branches that equal the default branch, archived repos, forks and repos with no default branch", async () => {
		const d = { files: { "package.json": dep("1") } };
		const gh = fakeGithub([], {
			same: { dev: { ...d, same: true } },
			arch: { dev: d, gql: { isArchived: true } },
			fork: { dev: d, gql: { isFork: true } },
			empty: { dev: d, gql: { defaultBranchRef: null } },
			nodev: {}
		});
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME });
		expect(out.scanned.devBranches).toBe(0);
		expect(out.dependents).toEqual([]);
		expect(gh.request.mock.calls.some((c: unknown[]) => String(c[0]).includes("/git/trees/"))).toBe(false);
	});

	it("flags a truncated dev tree in unread and still reports what it listed", async () => {
		const gh = fakeGithub([], { big: { dev: { truncated: true, files: { "package.json": dep("1") } } } });
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME, classify: false });
		expect(out.dependents[0]).toMatchObject({ branch: "dev", unread: [{ path: ".", reason: "tree-truncated" }] });
	});

	it("does not read dev branches with devBranches: false and says so in the note", async () => {
		const gh = fakeGithub([], { trunk: { dev: { files: { "package.json": dep("1") } } } });
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME, devBranches: false });
		expect(gh.request.mock.calls.map((c: unknown[]) => c[0])).toEqual(["GET /search/code"]);
		expect(out.discovery).toMatchObject({ devBranches: false });
		expect(out.discovery.note).toMatch(/not read/);
		expect(out.scanned).not.toHaveProperty("devBranches");
	});

	it("pages the GraphQL listing by cursor and flags max-repos when it never ends", async () => {
		const page = (n: number, hasNextPage: boolean) => ({
			data: { data: { repositoryOwner: { repositories: { pageInfo: { hasNextPage, endCursor: `c${n}` }, nodes: [] } } } },
			headers: {}
		});
		let n = 0;
		const request = vi.fn(async (route: string) => {
			if (route === "GET /search/code") return { data: { total_count: 0, incomplete_results: false, items: [] }, headers: {} };
			n++;
			return page(n, n < 2);
		});
		const out = await reportDependents({ request } as any, { owner: "CLDMV", name: NAME });
		expect(request.mock.calls[2]![1]).toMatchObject({ variables: { after: "c1" } });
		expect(out.truncated).toBeUndefined();

		const endless = vi.fn(async (route: string) =>
			route === "GET /search/code" ? { data: { total_count: 0, incomplete_results: false, items: [] }, headers: {} } : page(0, true)
		);
		const out2 = await reportDependents({ request: endless } as any, { owner: "CLDMV", name: NAME });
		expect(endless.mock.calls.filter((c) => c[0] === "POST /graphql")).toHaveLength(20);
		expect(out2.truncatedReason).toBe("max-repos");
	});

	it("only reads as many dev branches as maxRepos leaves room for", async () => {
		const d = { dev: { files: { "package.json": dep("1") } } };
		const gh = fakeGithub([["s", "package.json"]], { s: { files: { "package.json": dep("1") } }, a: d, b: d });
		const out = await reportDependents(gh, { owner: "CLDMV", name: NAME, classify: false, maxRepos: 2 });
		expect(out.dependents.map((x) => `${x.repo}@${x.branch}`)).toEqual(["CLDMV/a@dev", "CLDMV/s@master"]);
		expect(out.truncatedReason).toBe("max-repos");
	});

	it("throws when the GraphQL listing returns errors or no owner", async () => {
		const reply = (body: unknown) =>
			vi.fn(async (route: string) => (route === "GET /search/code" ? { data: { total_count: 0, incomplete_results: false, items: [] }, headers: {} } : { data: body, headers: {} }));
		await expect(reportDependents({ request: reply({ errors: [{ message: "boom" }, { message: "bang" }] }) } as any, { owner: "CLDMV", name: NAME })).rejects.toThrow(
			/listing dev branches failed: boom; bang/
		);
		await expect(reportDependents({ request: reply({ data: { repositoryOwner: null } }) } as any, { owner: "nobody", name: NAME })).rejects.toThrow(/no owner "nobody"/);
	});
});

describe("REPORT_DEPENDENTS_SCHEMA", () => {
	it("requires owner and name", () => {
		expect(REPORT_DEPENDENTS_SCHEMA.required).toEqual(["owner", "name"]);
		expect(REPORT_DEPENDENTS_SCHEMA.properties.devBranches).toMatchObject({ type: "boolean", default: true });
	});
});
