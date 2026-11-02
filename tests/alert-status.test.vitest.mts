import { describe, it, expect, vi } from "vitest";
import { reportAlertStatus, REPORT_ALERT_STATUS_SCHEMA } from "../src/verbs/report_alert_status.ts";

type Res = { data: unknown; headers?: Record<string, string> };
type Handler = (route: string, params: any) => Promise<Res>;

function octokitWith(handler: Handler): any {
	return { request: vi.fn(handler) };
}

const status = (code: number, message = "x", headers?: Record<string, string>) => Object.assign(new Error(message), { status: code, ...(headers ? { response: { headers } } : {}) });

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function alert(n: number, over: { pkg?: string; ecosystem?: string; manifest?: string | null; range?: string; patched?: string | null; createdAt?: string; repo?: string } = {}) {
	return {
		number: n,
		html_url: `https://github.com/CLDMV/r/security/dependabot/${n}`,
		created_at: over.createdAt ?? daysAgo(1),
		...(over.repo ? { repository: { full_name: over.repo } } : {}),
		dependency: {
			package: { ecosystem: over.ecosystem ?? "npm", name: over.pkg ?? "hono" },
			...(over.manifest === null ? {} : { manifest_path: over.manifest ?? "package-lock.json" }),
			scope: "runtime"
		},
		security_advisory: { ghsa_id: "GHSA-aaaa", summary: "bad", severity: "high" },
		security_vulnerability: {
			severity: "high",
			vulnerable_version_range: over.range ?? "< 4.13.7",
			first_patched_version: over.patched === null ? null : { identifier: over.patched ?? "4.13.7" }
		}
	};
}

let prSeq = 100;
function pr(over: Partial<{ number: number; title: string; body: string | null; state: string; draft: boolean; created_at: string; closed_at: string | null; merged_at: string | null; login: string; head: string; base: string }> = {}) {
	const number = over.number ?? prSeq++;
	return {
		number,
		html_url: `https://github.com/CLDMV/r/pull/${number}`,
		title: over.title ?? "Bump hono from 4.1.0 to 4.13.7",
		body: over.body === undefined ? "Bumps [hono](https://github.com/honojs/hono) from 4.1.0 to 4.13.7." : over.body,
		state: over.state ?? "open",
		draft: over.draft ?? false,
		created_at: over.created_at ?? daysAgo(2),
		closed_at: over.closed_at ?? null,
		merged_at: over.merged_at ?? null,
		user: { login: over.login ?? "dependabot[bot]" },
		head: { ref: over.head ?? `dependabot/npm_and_yarn/hono-${number}` },
		base: { ref: over.base ?? "next" }
	};
}

const npmLock = (pkgs: Record<string, string[]>) => {
	const packages: Record<string, { version: string }> = { "": { version: "1.0.0" } };
	for (const [name, versions] of Object.entries(pkgs)) versions.forEach((v, i) => (packages[i === 0 ? `node_modules/${name}` : `node_modules/x${i}/node_modules/${name}`] = { version: v }));
	return JSON.stringify({ lockfileVersion: 3, packages });
};

type FileSpec = string | { size?: number; noContent?: boolean; text?: string; dir?: boolean; type?: string };

interface World {
	defaultBranch?: string;
	branches?: Record<string, string | undefined>;
	alerts?: unknown[];
	pulls?: unknown[];
	/** sha → path → contents */
	files?: Record<string, Record<string, FileSpec>>;
}

/** A fake GitHub for one repo (CLDMV/r) unless an override handles the route first. */
function world(w: World, override?: (route: string, params: any) => Res | undefined | Promise<Res | undefined>): Handler {
	const branches = w.branches ?? { master: "s-main" };
	return async (route, params) => {
		const o = override ? await override(route, params) : undefined;
		if (o) return o;
		switch (route) {
			case "GET /repos/{owner}/{repo}/dependabot/alerts":
				return { data: w.alerts ?? [], headers: {} };
			case "GET /repos/{owner}/{repo}":
				return { data: { default_branch: w.defaultBranch ?? "master" }, headers: {} };
			case "GET /repos/{owner}/{repo}/branches/{branch}": {
				const sha = branches[params.branch];
				if (!sha) throw status(404, "Branch not found");
				return { data: { commit: { sha } }, headers: {} };
			}
			case "GET /repos/{owner}/{repo}/pulls":
				return { data: params.page === 1 ? (w.pulls ?? []) : [], headers: {} };
			case "GET /repos/{owner}/{repo}/contents/{path}": {
				const f = w.files?.[params.ref]?.[params.path];
				if (f === undefined) throw status(404, "Not Found");
				if (typeof f === "string") return { data: { type: "file", size: f.length, sha: `blob-${params.path}`, encoding: "base64", content: Buffer.from(f).toString("base64") }, headers: {} };
				if (f.dir) return { data: [{ type: "file" }], headers: {} };
				return { data: { type: f.type ?? "file", ...(f.size !== undefined ? { size: f.size } : {}), sha: `blob:${f.text ?? ""}`, encoding: f.noContent ? "none" : "base64", content: f.noContent ? "" : Buffer.from(f.text ?? "").toString("base64") }, headers: {} };
			}
			case "GET /repos/{owner}/{repo}/git/blobs/{file_sha}":
				return { data: { content: Buffer.from(String(params.file_sha).slice(5)).toString("base64") }, headers: {} };
		}
		throw new Error(`unexpected route ${route}`);
	};
}

const run = (w: World, input: Record<string, unknown> = {}, override?: Parameters<typeof world>[1]) => {
	const octokit = octokitWith(world(w, override));
	return { octokit, out: reportAlertStatus(octokit, { owner: "cldmv", repo: "r", ...input }) };
};

describe("reportAlertStatus — buckets", () => {
	it("released-still-open when the default branch's lockfile is already patched", async () => {
		const { out } = run({ alerts: [alert(1)], files: { "s-main": { "package-lock.json": npmLock({ hono: ["4.13.7"] }) } } });
		const res = await out;
		expect(res.scope).toBe("repo");
		expect(res.scanned).toEqual({ repos: 1, alerts: 1 });
		expect(res.summary).toEqual({ "released-still-open": 1, "fixed-on-next": 0, "open-pr": 0, "closed-unmerged": 0, "no-pr": 0 });
		const row = res.repos[0]!;
		expect(row).toMatchObject({ repo: "cldmv/r", defaultBranch: "master", branches: { next: false, hotfixes: false }, prsScanned: 0, counts: { "released-still-open": 1 } });
		expect(row.alerts[0]).toMatchObject({
			number: 1,
			package: "hono",
			ecosystem: "npm",
			manifest: "package-lock.json",
			vulnerableRange: "< 4.13.7",
			patchedVersion: "4.13.7",
			bucket: "released-still-open",
			lockfile: { default: { state: "fixed", path: "package-lock.json", versions: ["4.13.7"] } },
			openPrs: []
		});
		expect(row.alerts[0]!.reason).toContain("4.13.7");
		expect(row.alerts[0]!.lockfile!.next).toBeUndefined();
	});

	it("released-still-open says 'not present' when the package is gone from the lockfile", async () => {
		const { out } = run({ alerts: [alert(1)], files: { "s-main": { "package-lock.json": npmLock({}) } } });
		const a = (await out).repos[0]!.alerts[0]!;
		expect(a.bucket).toBe("released-still-open");
		expect(a.reason).toContain("not present");
	});

	it("fixed-on-next when next is patched and the default branch is not", async () => {
		const { out } = run({
			branches: { master: "s-main", next: "s-next" },
			alerts: [alert(1)],
			files: { "s-main": { "package-lock.json": npmLock({ hono: ["4.1.0"] }) }, "s-next": { "package-lock.json": npmLock({ hono: ["4.14.0"] }) } }
		});
		const res = await out;
		const a = res.repos[0]!.alerts[0]!;
		expect(res.repos[0]!.branches).toEqual({ next: true, hotfixes: false });
		expect(a.bucket).toBe("fixed-on-next");
		expect(a.lockfile).toEqual({
			default: { state: "vulnerable", path: "package-lock.json", versions: ["4.1.0"] },
			next: { state: "fixed", path: "package-lock.json", versions: ["4.14.0"] }
		});
		expect(a.reason).toBe("next resolves hono 4.14.0; waiting for a release");
	});

	it("fixed-on-next via hotfixes, including a package removed there", async () => {
		const { out } = run({
			branches: { master: "s-main", next: "s-main", hotfixes: "s-hot" },
			alerts: [alert(1)],
			files: { "s-main": { "package-lock.json": npmLock({ hono: ["4.1.0"] }) }, "s-hot": { "package-lock.json": npmLock({}) } }
		});
		const a = (await out).repos[0]!.alerts[0]!;
		expect(a.bucket).toBe("fixed-on-next");
		expect(a.lockfile!.next!.state).toBe("vulnerable");
		expect(a.reason).toBe("hotfixes resolves hono (removed); waiting for a release");
	});

	it("reads each lockfile once per commit — a next equal to the default branch costs nothing", async () => {
		const { octokit, out } = run({
			branches: { master: "s-main", next: "s-main" },
			alerts: [alert(1), alert(2)],
			files: { "s-main": { "package-lock.json": npmLock({ hono: ["4.1.0"] }) } }
		});
		await out;
		const contents = octokit.request.mock.calls.filter((c: any[]) => c[0] === "GET /repos/{owner}/{repo}/contents/{path}");
		expect(contents).toHaveLength(1);
	});

	it("open-pr, noting the hotfix-redirect twin of a PR against the default branch and drafts", async () => {
		const original = pr({ number: 7, base: "master" });
		const twin = pr({ number: 8, base: "hotfixes", head: "hotfix-redirect/pr-7", login: "cldmv-bot[bot]" });
		const nextPr = pr({ number: 9, base: "next", draft: true, title: "deps: update hono", body: "updates `hono`" });
		const { out } = run({ alerts: [alert(1)], pulls: [original, twin, nextPr], files: { "s-main": { "package-lock.json": npmLock({ hono: ["4.1.0"] }) } } });
		const a = (await out).repos[0]!.alerts[0]!;
		expect(a.bucket).toBe("open-pr");
		expect(a.openPrs).toEqual([
			{ number: 7, url: original.html_url, title: original.title, base: "master", head: original.head.ref, hotfixRedirect: 8 },
			{ number: 8, url: twin.html_url, title: twin.title, base: "hotfixes", head: "hotfix-redirect/pr-7" },
			{ number: 9, url: nextPr.html_url, title: nextPr.title, base: "next", head: nextPr.head.ref, draft: true }
		]);
		expect(a.reason).toBe("open PR #7, #8, #9");
	});

	it("closed-unmerged, with supersededBy when a later PR for the package merged", async () => {
		const closedOld = pr({ number: 3, state: "closed", closed_at: "2026-09-01T00:00:00Z" });
		const closedNoDate = pr({ number: 4, state: "closed", created_at: "2026-10-20T00:00:00Z" });
		const mergedEarly = pr({ number: 5, state: "closed", merged_at: "2026-08-01T00:00:00Z", closed_at: "2026-08-01T00:00:00Z" });
		const mergedLate = pr({ number: 6, state: "closed", merged_at: "2026-09-10T00:00:00Z", base: "master" });
		const mergedLater = pr({ number: 10, state: "closed", merged_at: "2026-09-20T00:00:00Z" });
		const { out } = run({
			alerts: [alert(1)],
			pulls: [closedOld, closedNoDate, mergedEarly, mergedLater, mergedLate],
			files: { "s-main": { "package-lock.json": npmLock({ hono: ["4.1.0"] }) } }
		});
		const a = (await out).repos[0]!.alerts[0]!;
		expect(a.bucket).toBe("closed-unmerged");
		expect(a.closedPrs).toEqual([
			{ number: 3, url: closedOld.html_url, title: closedOld.title, closedAt: "2026-09-01T00:00:00Z", supersededBy: 6 },
			{ number: 4, url: closedNoDate.html_url, title: closedNoDate.title, closedAt: "2026-10-20T00:00:00Z" }
		]);
		expect(a.mergedPrs).toHaveLength(3);
		expect(a.mergedPrs![2]).toEqual({ number: 6, url: mergedLate.html_url, title: mergedLate.title, base: "master", mergedAt: "2026-09-10T00:00:00Z" });
		expect(a.reason).toBe("2 closed unmerged PR(s), 1 superseded by a later merge");
	});

	it("closed-unmerged without any superseding merge", async () => {
		const { out } = run({ alerts: [alert(1)], pulls: [pr({ state: "closed", closed_at: daysAgo(3) })], files: { "s-main": { "package-lock.json": npmLock({ hono: ["4.1.0"] }) } } });
		expect((await out).repos[0]!.alerts[0]!.reason).toBe("1 closed unmerged PR(s)");
	});

	it("no-pr, and says so when merged PRs did not clear it", async () => {
		const merged = pr({ state: "closed", merged_at: daysAgo(4) });
		const lock = { "s-main": { "package-lock.json": npmLock({ hono: ["4.1.0"] }) } };
		const none = (await run({ alerts: [alert(1)], files: lock }).out).repos[0]!.alerts[0]!;
		expect(none).toMatchObject({ bucket: "no-pr", reason: "no PR for this package", openPrs: [] });
		expect(none.closedPrs).toBeUndefined();
		const withMerged = (await run({ alerts: [alert(1)], pulls: [merged], files: lock }).out).repos[0]!.alerts[0]!;
		expect(withMerged).toMatchObject({ bucket: "no-pr", reason: "no open PR; 1 merged PR(s) did not clear it" });
	});

	it("buckets a non-npm alert from its PRs alone, without reading a lockfile", async () => {
		const { octokit, out } = run({ alerts: [alert(1, { ecosystem: "pip", pkg: "requests", manifest: "requirements.txt" })], pulls: [pr({ title: "Bump requests from 2.0 to 2.32", body: null })] });
		const a = (await out).repos[0]!.alerts[0]!;
		expect(a.bucket).toBe("open-pr");
		expect(a.lockfile).toBeUndefined();
		expect(octokit.request.mock.calls.some((c: any[]) => c[0] === "GET /repos/{owner}/{repo}/contents/{path}")).toBe(false);
	});

	it("orders alerts by bucket then number and filters by buckets without changing the counts", async () => {
		const w: World = {
			alerts: [alert(3, { pkg: "a" }), alert(1, { pkg: "b" }), alert(2, { pkg: "a" })],
			pulls: [pr({ title: "Bump a from 1 to 5", body: "" })],
			files: { "s-main": { "package-lock.json": npmLock({ a: ["1.0.0"], b: ["9.0.0"] }) } }
		};
		const all = (await run(w).out).repos[0]!;
		expect(all.alerts.map((a) => [a.number, a.bucket])).toEqual([
			[1, "released-still-open"],
			[2, "open-pr"],
			[3, "open-pr"]
		]);
		const filtered = await run(w, { buckets: ["open-pr"] }).out;
		expect(filtered.repos[0]!.alerts.map((a) => a.number)).toEqual([2, 3]);
		expect(filtered.repos[0]!.counts).toEqual({ "released-still-open": 1, "open-pr": 2 });
		expect(filtered.summary["released-still-open"]).toBe(1);
		const empty = await run(w, { buckets: [] }).out;
		expect(empty.repos[0]!.alerts).toHaveLength(3);
	});
});

describe("reportAlertStatus — lockfile resolution", () => {
	it("resolves a monorepo manifest to the nearest lockfile, walking up to the workspace root", async () => {
		const { out } = run({
			alerts: [alert(1, { manifest: "packages/app/package.json" }), alert(2, { manifest: "packages/lib/package-lock.json" }), alert(3, { manifest: "tools/pnpm-lock.yaml" })],
			files: {
				"s-main": {
					"pnpm-lock.yaml": "packages:\n  hono@4.20.0:\n",
					"packages/lib/package-lock.json": npmLock({ hono: ["4.1.0"] }),
					"tools/pnpm-lock.yaml": "packages:\n  /hono/4.0.0:\n"
				}
			}
		});
		const alerts = (await out).repos[0]!.alerts;
		const by = Object.fromEntries(alerts.map((a) => [a.number, a.lockfile!.default]));
		expect(by[1]).toEqual({ state: "fixed", path: "pnpm-lock.yaml", versions: ["4.20.0"] });
		expect(by[2]).toEqual({ state: "vulnerable", path: "packages/lib/package-lock.json", versions: ["4.1.0"] });
		expect(by[3]).toEqual({ state: "vulnerable", path: "tools/pnpm-lock.yaml", versions: ["4.0.0"] });
	});

	it("defaults to the root package-lock.json when the alert names no manifest", async () => {
		const { out } = run({ alerts: [alert(1, { manifest: null })], files: { "s-main": { "package-lock.json": npmLock({ hono: ["4.1.0"] }) } } });
		const a = (await out).repos[0]!.alerts[0]!;
		expect(a.manifest).toBeUndefined();
		expect(a.lockfile!.default.state).toBe("vulnerable");
	});

	it("reads a lockfile over 1 MB through the blob API", async () => {
		const { octokit, out } = run({ alerts: [alert(1)], files: { "s-main": { "package-lock.json": { noContent: true, text: npmLock({ hono: ["4.13.7"] }) } } } });
		expect((await out).repos[0]!.alerts[0]!.lockfile!.default).toMatchObject({ state: "fixed" });
		expect(octokit.request.mock.calls.some((c: any[]) => c[0] === "GET /repos/{owner}/{repo}/git/blobs/{file_sha}")).toBe(true);
	});

	it("reports the unknown states: too large, unparsed, no version info, no lockfile, missing branch", async () => {
		const big = (await run({ alerts: [alert(1)], files: { "s-main": { "package-lock.json": { size: 99, text: "{}" } } } }, { maxLockfileBytes: 10 }).out).repos[0]!.alerts[0]!;
		expect(big.lockfile!.default).toEqual({ state: "unknown", path: "package-lock.json", reason: "too-large" });
		expect(big.bucket).toBe("no-pr");

		const noSize = (await run({ alerts: [alert(1)], files: { "s-main": { "package-lock.json": { text: npmLock({ hono: ["4.1.0"] }) } } } }).out).repos[0]!.alerts[0]!;
		expect(noSize.lockfile!.default.state).toBe("vulnerable");

		const bad = (await run({ alerts: [alert(1)], files: { "s-main": { "package-lock.json": "{nope" } } }).out).repos[0]!.alerts[0]!;
		expect(bad.lockfile!.default).toEqual({ state: "unknown", path: "package-lock.json", reason: "unparsed" });

		const noInfo = (await run({ alerts: [alert(1, { range: "weird", patched: null })], files: { "s-main": { "package-lock.json": npmLock({ hono: ["4.1.0"] }) } } }).out).repos[0]!.alerts[0]!;
		expect(noInfo.lockfile!.default).toEqual({ state: "unknown", path: "package-lock.json", versions: ["4.1.0"], reason: "no-version-info" });
		expect(noInfo.patchedVersion).toBeUndefined();

		const dir = (await run({ alerts: [alert(1)], files: { "s-main": { "package-lock.json": { dir: true } } } }).out).repos[0]!.alerts[0]!;
		expect(dir.lockfile!.default).toEqual({ state: "unknown", reason: "no-lockfile" });

		const link = (await run({ alerts: [alert(1)], files: { "s-main": { "package-lock.json": { type: "symlink" } } } }).out).repos[0]!.alerts[0]!;
		expect(link.lockfile!.default).toEqual({ state: "unknown", reason: "no-lockfile" });

		const noDefault = (await run({ branches: { next: "s-next" }, alerts: [alert(1)], files: { "s-next": { "package-lock.json": npmLock({ hono: ["4.1.0"] }) } } }).out).repos[0]!.alerts[0]!;
		expect(noDefault.lockfile!.default).toEqual({ state: "unknown", reason: "no-branch" });
		expect(noDefault.lockfile!.next!.state).toBe("vulnerable");
	});

	it("propagates a non-404 contents error", async () => {
		const { out } = run({ alerts: [alert(1)] }, {}, (route) => {
			if (route === "GET /repos/{owner}/{repo}/contents/{path}") throw status(500, "server exploded");
			return undefined;
		});
		await expect(out).rejects.toThrow("server exploded");
	});
});

describe("reportAlertStatus — PR matching", () => {
	it("matches the package as a title word or a body link/code span, only on dependency PRs", async () => {
		const pulls = [
			pr({ number: 1, title: "Bump hono-extra from 1 to 2", body: "Bumps [hono-extra](x)" }),
			pr({ number: 2, title: "feat: hono middleware", body: "", login: "Shinrai", head: "feat/x" }),
			pr({ number: 3, title: "Bump the npm_and_yarn group with 2 updates", body: "Bumps the group: [hono](x) and [ws](y)" }),
			pr({ number: 4, title: "chore: refresh", body: "Updates `hono` from 4.1.0", login: "Shinrai", head: "dependabot/manual" }),
			pr({ number: 5, title: "fix(deps): hono to 4.13.7", body: null, login: "Shinrai", head: "fix/hono" }),
			pr({ number: 6, title: "unrelated", body: "mentions hono in passing", login: "Shinrai", head: "x" }),
			pr({ number: 7, title: "Bump ws from 1 to 2", body: null })
		];
		const { out } = run({ alerts: [alert(1, { ecosystem: "", range: "" })], pulls });
		const a = (await out).repos[0]!.alerts[0]!;
		expect(a.openPrs.map((p) => p.number)).toEqual([3, 4, 5]);
		expect(a.ecosystem).toBeUndefined();
		expect(a.vulnerableRange).toBeUndefined();
		expect(a.lockfile).toBeUndefined();
	});
});

describe("reportAlertStatus — Dependabot paused hint", () => {
	it("looks paused when an older fixable alert has seen no Dependabot PR since", async () => {
		const pulls = [pr({ created_at: daysAgo(40), title: "Bump ws from 1 to 2", body: "" }), pr({ created_at: daysAgo(1), login: "Shinrai", title: "chore: x", head: "chore/x", body: "" })];
		const res = await run({ alerts: [alert(1, { createdAt: daysAgo(20) }), alert(2, { createdAt: daysAgo(30), patched: null }), alert(3, { createdAt: daysAgo(50) })], pulls }, { alertLimit: 10 }).out;
		const d = res.repos[0]!.dependabot;
		expect(d.looksPaused).toBe(true);
		expect(d.lastPrAt).toBe(pulls[0]!.created_at);
		expect(d.reason).toBe(`1 fixable alert(s) older than 7 days with no Dependabot PR opened since (last one ${pulls[0]!.created_at})`);
	});

	it("looks paused with no Dependabot PR at all, and not paused when PRs keep coming or alerts are fresh", async () => {
		const none = (await run({ alerts: [alert(1, { createdAt: daysAgo(10) })] }).out).repos[0]!.dependabot;
		expect(none).toEqual({ looksPaused: true, reason: "1 fixable alert(s) older than 7 days with no Dependabot PR opened since (none in the PRs read)" });
		const fresh = (await run({ alerts: [alert(1, { createdAt: daysAgo(2) })] }).out).repos[0]!.dependabot;
		expect(fresh).toEqual({ looksPaused: false });
		const answered = (await run({ alerts: [alert(1, { createdAt: daysAgo(10) })], pulls: [pr({ created_at: daysAgo(5) })] }).out).repos[0]!.dependabot;
		expect(answered.looksPaused).toBe(false);
	});

	it("handles a PR with no user and flags a PR list cut at prLimit", async () => {
		const ghost = { ...pr({ title: "chore: x", head: "chore/x", body: "" }), user: null };
		const res = await run({ alerts: [alert(1, { ecosystem: "pip" })], pulls: [ghost, pr({ title: "chore: y", head: "chore/y", body: "", login: "Shinrai" })] }, { prLimit: 2 }).out;
		expect(res.repos[0]!.prsScanned).toBe(2);
		expect(res.repos[0]!.prListTruncated).toBe(true);
		expect(res.repos[0]!.dependabot.lastPrAt).toBeUndefined();
	});
});

describe("reportAlertStatus — scope", () => {
	it("reads several named repos, stripping the owner prefix and de-duplicating, and counts disabled ones", async () => {
		const seen: string[] = [];
		const octokit = octokitWith(
			world({ alerts: [alert(1, { ecosystem: "pip" })] }, (route, params) => {
				if (route === "GET /repos/{owner}/{repo}/dependabot/alerts") {
					seen.push(params.repo);
					if (params.repo === "off") throw status(403, "Dependabot alerts are disabled");
					return { data: [alert(1, { ecosystem: "pip", repo: `CLDMV/${params.repo}` })], headers: {} };
				}
				return undefined;
			})
		);
		const res = await reportAlertStatus(octokit, { owner: "cldmv", repos: ["CLDMV/a", "a", "off", "b"] });
		expect(seen).toEqual(["a", "off", "b"]);
		expect(res.scope).toBe("repo");
		expect(res.disabled).toBe(1);
		expect(res.repos.map((r) => r.repo)).toEqual(["CLDMV/a", "CLDMV/b"]);
	});

	it("reads the org endpoint once for every repo, skipping alerts without a package", async () => {
		const noPkg = { ...alert(9, { repo: "CLDMV/z" }), dependency: {} };
		const octokit = octokitWith(
			world({}, (route) => {
				if (route === "GET /orgs/{owner}/dependabot/alerts") return { data: [alert(1, { repo: "CLDMV/b", ecosystem: "pip" }), alert(2, { repo: "CLDMV/a", ecosystem: "pip" }), noPkg], headers: {} };
				return undefined;
			})
		);
		const res = await reportAlertStatus(octokit, { owner: "cldmv" });
		expect(res.scope).toBe("org");
		expect(res.repos.map((r) => r.repo)).toEqual(["CLDMV/a", "CLDMV/b"]);
		expect(res.scanned).toEqual({ repos: 2, alerts: 2 });
	});

	it("falls back to a per-repo sweep when the org endpoint is unavailable, capped at maxRepos", async () => {
		const octokit = octokitWith(
			world({}, (route, params) => {
				if (route === "GET /orgs/{owner}/dependabot/alerts") throw status(404, "Not Found");
				if (route === "GET /orgs/{owner}/repos") return { data: [{ name: "a" }, { name: "b" }, { name: "c" }], headers: {} };
				if (route === "GET /repos/{owner}/{repo}/dependabot/alerts") return { data: params.repo === "a" ? [alert(1, { ecosystem: "pip", repo: "CLDMV/a" })] : [], headers: {} };
				return undefined;
			})
		);
		const within = await reportAlertStatus(octokit, { owner: "cldmv" });
		expect(within.scope).toBe("per-repo");
		expect(within.truncated).toBeUndefined();
		const res = await reportAlertStatus(octokit, { owner: "cldmv", maxRepos: 2 });
		expect(res.scope).toBe("per-repo");
		expect(res.truncated).toBe(true);
		expect(res.truncatedReason).toBe("max-repos");
		expect(res.repos.map((r) => r.repo)).toEqual(["CLDMV/a"]);
	});

	it("flags max-alerts in org mode and per repo", async () => {
		const org = octokitWith(
			world({}, (route) => {
				if (route === "GET /orgs/{owner}/dependabot/alerts") return { data: [alert(1, { repo: "CLDMV/r", ecosystem: "pip" })], headers: {} };
				return undefined;
			})
		);
		expect((await reportAlertStatus(org, { owner: "cldmv", alertLimit: 1 })).truncatedReason).toBe("max-alerts");
		expect((await run({ alerts: [alert(1, { ecosystem: "pip" })] }, { alertLimit: 1 }).out).truncatedReason).toBe("max-alerts");
	});

	it("propagates unexpected alert-endpoint errors", async () => {
		const org = octokitWith(async () => {
			throw status(500, "org exploded");
		});
		await expect(reportAlertStatus(org, { owner: "cldmv" })).rejects.toThrow("org exploded");
		await expect(reportAlertStatus(org, { owner: "cldmv", repo: "r" })).rejects.toThrow("org exploded");
	});

	it("propagates a non-404 branch error", async () => {
		const { out } = run({ alerts: [alert(1, { ecosystem: "pip" })] }, {}, (route) => {
			if (route === "GET /repos/{owner}/{repo}/branches/{branch}") throw status(500, "branch exploded");
			return undefined;
		});
		await expect(out).rejects.toThrow("branch exploded");
	});
});

describe("reportAlertStatus — fan-out safety", () => {
	const twoRepos = () =>
		world({ branches: { master: "s-main" }, files: { "s-main": { "package-lock.json": npmLock({ hono: ["4.1.0"] }) } } }, (route) => {
			if (route === "GET /orgs/{owner}/dependabot/alerts") return { data: [alert(1, { repo: "CLDMV/a" }), alert(2, { repo: "CLDMV/b" })], headers: {} };
			return undefined;
		});

	it("stops at maxApiCalls, keeping finished repos and listing the rest as pending", async () => {
		// org alerts (1) + repo a: repo, 3 branches, pulls, contents (6) = 7 calls; repo b then runs out.
		const res = await reportAlertStatus(octokitWith(twoRepos()), { owner: "cldmv", maxApiCalls: 9 });
		expect(res.truncated).toBe(true);
		expect(res.truncatedReason).toBe("max-api-calls");
		expect(res.repos.map((r) => r.repo)).toEqual(["CLDMV/a"]);
		expect(res.pending).toEqual(["CLDMV/b"]);
		expect(res.scanned).toEqual({ repos: 1, alerts: 1 });
	});

	it("stops when the budget runs out on a branch or lockfile read", async () => {
		const atBranch = await reportAlertStatus(octokitWith(twoRepos()), { owner: "cldmv", maxApiCalls: 3 });
		expect(atBranch.pending).toEqual(["CLDMV/a", "CLDMV/b"]);
		const atLock = await reportAlertStatus(octokitWith(twoRepos()), { owner: "cldmv", maxApiCalls: 6 });
		expect(atLock.truncatedReason).toBe("max-api-calls");
		expect(atLock.repos).toEqual([]);
	});

	it("stops on a rate limit, passing on Retry-After", async () => {
		const limited = world({ alerts: [alert(1)] }, (route) => {
			if (route === "GET /repos/{owner}/{repo}/contents/{path}") throw status(403, "API rate limit exceeded", { "retry-after": "30" });
			return undefined;
		});
		const res = await reportAlertStatus(octokitWith(limited), { owner: "cldmv", repo: "r" });
		expect(res).toMatchObject({ truncated: true, truncatedReason: "rate-limited", retryAfterSeconds: 30, pending: ["cldmv/r"], repos: [] });

		const floor = world({}, (route) => {
			if (route === "GET /orgs/{owner}/dependabot/alerts") return { data: [], headers: { "x-ratelimit-remaining": "1", "x-ratelimit-limit": "5000" } };
			return undefined;
		});
		const res2 = await reportAlertStatus(octokitWith(floor), { owner: "cldmv" });
		expect(res2.truncatedReason).toBe("rate-limited");
		expect(res2.retryAfterSeconds).toBeUndefined();
		expect(res2.pending).toBeUndefined();
	});

	it("clamps oversized caps to their hard limits", async () => {
		const octokit = octokitWith(world({ alerts: [] }));
		const res = await reportAlertStatus(octokit, { owner: "cldmv", repo: "r", maxApiCalls: 1e9, alertLimit: 1e9, prLimit: 1e9, maxLockfileBytes: 1e12, maxRepos: 1e9 });
		expect(res).toEqual({ scanned: { repos: 0, alerts: 0 }, scope: "repo", summary: { "released-still-open": 0, "fixed-on-next": 0, "open-pr": 0, "closed-unmerged": 0, "no-pr": 0 }, repos: [] });
	});
});

describe("REPORT_ALERT_STATUS_SCHEMA", () => {
	it("requires owner, rejects unknown keys and lists the buckets", () => {
		expect(REPORT_ALERT_STATUS_SCHEMA.required).toEqual(["owner"]);
		expect(REPORT_ALERT_STATUS_SCHEMA.additionalProperties).toBe(false);
		expect(REPORT_ALERT_STATUS_SCHEMA.properties.buckets.items.enum).toEqual(["released-still-open", "fixed-on-next", "open-pr", "closed-unmerged", "no-pr"]);
	});
});
