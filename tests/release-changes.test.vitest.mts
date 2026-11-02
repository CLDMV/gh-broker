import { describe, it, expect, vi } from "vitest";
import {
	reportReleaseChanges,
	parseConventional,
	revertedPr,
	closingIssues,
	breakingHints,
	sectionFor,
	isGenerated,
	exportKeys,
	dependencyChanges,
	packageJsonDelta,
	releaseType,
	buildSkeleton,
	REPORT_RELEASE_CHANGES_SCHEMA
} from "../src/verbs/report_release_changes.ts";

type Handler = (route: string, params: any) => Promise<{ data: unknown; headers?: Record<string, string> }>;

const octokitWith = (handler: Handler): any => ({ request: vi.fn(handler) });
const status = (code: number, message = "x") => Object.assign(new Error(message), { status: code });
const ok = (data: unknown) => ({ data, headers: {} });
const commit = (message: string, sha = message) => ({ sha, commit: { message } });

const pullData = (number: number, title: string, over: Record<string, unknown> = {}) => ({
	number,
	title,
	html_url: `https://github.com/CLDMV/r/pull/${number}`,
	body: "",
	user: { login: "Shinrai" },
	labels: [],
	merged_at: "2026-10-30T00:00:00Z",
	additions: 1,
	deletions: 1,
	changed_files: 1,
	head: { ref: "feat/x", sha: `sha${number}` },
	base: { ref: "next" },
	...over
});

const RELEASE = pullData(100, "release: v1.3.0 - stuff", { head: { ref: "next", sha: "headsha" }, base: { ref: "master" }, changed_files: 3, additions: 50, deletions: 10 });

const RELEASE_COMMITS = [
	commit("feat: add x (#10)\n\nbody mentions #3"),
	commit("wip"),
	commit("Merge pull request #11 from CLDMV/fix/y\n\nfix: y"),
	commit("docs: changelog for v1.3.0 (#12)"),
	commit("chore: bump version to 1.3.0"),
	commit("fix: old thing (#5)"),
	commit("feat: old other (#6)"),
	commit("feat: temp (#13)"),
	commit('Revert "feat: temp (#13)" (#14)'),
	commit("refactor: z (#15)"),
	commit("deps: bump a (#16)")
];

const PRS: Record<number, unknown> = {
	100: RELEASE,
	10: pullData(10, "feat: add x", { labels: [{ name: "type: feature" }], body: "Closes #3, fixes other/repo#4 and resolves CLDMV/r#7" }),
	11: pullData(11, "fix: y", { labels: [{ name: "type: bug" }], changed_files: 2 }),
	15: pullData(15, "refactor(core): z", { body: null, user: null }),
	16: pullData(16, "deps: bump a", { user: { login: "dependabot[bot]" } })
};

const PKG_BASE = { version: "1.2.1", engines: { node: ">=20" }, exports: { ".": "./a.mjs", "./old": "./o.mjs" }, dependencies: { a: "^1.0.0", gone: "^1.0.0" }, devDependencies: { d: "^2.0.0" } };
const PKG_HEAD = { version: "1.3.0", engines: { node: ">=22" }, exports: { ".": "./a.mjs", "./new": "./n.mjs" }, dependencies: { a: "^1.1.0", added: "^3.0.0" }, devDependencies: { d: "^2.0.0" } };
const LOCK_BASE = { packages: { "node_modules/a": { version: "1.0.5" }, "node_modules/d": { version: "2.0.0" }, "node_modules/gone": { version: "1.0.0" } } };
const LOCK_HEAD = { packages: { "node_modules/a": { version: "1.1.2" }, "node_modules/d": { version: "2.0.1" }, "node_modules/added": { version: "3.0.0" } } };

const CONTENTS: Record<string, string> = {
	"master:docs/changelogs/v1/v1.2.1.md": "# v1.2.1\n\n- old other (#6)",
	"headsha:docs/changelog/v1/v1.3.0.md": "# r v1.3.0 Changelog\n\n- add x ([#10](https://github.com/CLDMV/r/pull/10))",
	"master:package.json": JSON.stringify(PKG_BASE),
	"headsha:package.json": JSON.stringify(PKG_HEAD),
	"master:package-lock.json": JSON.stringify(LOCK_BASE),
	"headsha:package-lock.json": JSON.stringify(LOCK_HEAD)
};

const FILES: Record<number, unknown[]> = {
	100: [
		{ filename: "src/a.ts", status: "modified", additions: 40, deletions: 5 },
		{ filename: "package-lock.json", status: "modified", additions: 10, deletions: 5 }
	],
	10: [
		{ filename: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
		{ filename: "package-lock.json", status: "modified", additions: 1, deletions: 1, patch: "@@ lock" },
		{ filename: "assets/logo.png", status: "added", additions: 0, deletions: 0 }
	]
};

function handler(over: Record<string, (params: any) => unknown> = {}): Handler {
	return async (route, p) => {
		if (over[route]) return ok(over[route]!(p));
		switch (route) {
			case "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
				if (p.pull_number === 404) throw status(404, "Not Found");
				return ok(PRS[p.pull_number] ?? pullData(p.pull_number, `chore: pr ${p.pull_number}`));
			}
			case "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits":
				if (p.pull_number === 100) return ok(RELEASE_COMMITS);
				if (p.pull_number === 90) return ok([commit("fix: hot (#20)")]);
				if (p.pull_number === 80) return ok([commit("fix: old thing (#5)")]);
				return ok([]);
			case "GET /repos/{owner}/{repo}/commits":
				return ok([commit("release: v1.2.1 - hotfix", "h1"), commit("release: v1.2.0 - minor", "r1"), commit("release: v1.1.0 - older", "r0"), commit("feat: on master", "m1")]);
			case "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls":
				if (p.commit_sha === "h1") return ok([{ number: 90, title: "release: v1.2.1 - hotfix", html_url: "https://github.com/CLDMV/r/pull/90", head: { ref: "hotfixes" } }]);
				return ok([{ number: 80, title: "release: v1.2.0 - minor", html_url: "https://github.com/CLDMV/r/pull/80", head: { ref: "next" } }]);
			case "GET /repos/{owner}/{repo}/compare/{basehead}":
				return ok({ commits: [{ sha: "h1", commit: { message: "release: v1.2.1 - hotfix" } }] });
			case "GET /repos/{owner}/{repo}/contents/{path}": {
				expect(p.mediaType).toEqual({ format: "raw" });
				const text = CONTENTS[`${p.ref}:${p.path}`];
				if (text === undefined) throw status(404, "Not Found");
				return ok(text);
			}
			case "GET /repos/{owner}/{repo}/pulls/{pull_number}/files":
				return ok(FILES[p.pull_number] ?? []);
		}
		throw new Error(`unexpected route ${route}`);
	};
}

const run = (input: Record<string, unknown> = {}, over?: Record<string, (params: any) => unknown>) =>
	reportReleaseChanges(octokitWith(handler(over)), { owner: "CLDMV", repo: "r", pull: 100, ...input });

describe("parseConventional", () => {
	it("reads type, scope and the breaking bang", () => {
		expect(parseConventional("feat(API)!: x")).toEqual({ type: "feat", scope: "api", bang: true });
		expect(parseConventional("fix: y")).toEqual({ type: "fix", bang: false });
		expect(parseConventional("Update readme")).toEqual({ type: "", bang: false });
	});
});

describe("revertedPr", () => {
	it("finds the PR a squash or merge-commit revert undoes", () => {
		expect(revertedPr('Revert "feat: temp (#13)"')).toBe(13);
		expect(revertedPr("Merge pull request #15 from CLDMV/revert-12-feat/x")).toBe(12);
	});
	it("returns undefined when there is no PR number or it isn't a revert", () => {
		expect(revertedPr('Revert "feat: temp"')).toBeUndefined();
		expect(revertedPr("Merge pull request #15 from CLDMV/fix/x")).toBeUndefined();
		expect(revertedPr("feat: x")).toBeUndefined();
	});
});

describe("closingIssues", () => {
	it("keeps same-repo closing keywords and drops other repos", () => {
		expect(closingIssues("Closes #3, fixes other/repo#4 and resolves CLDMV/r#7. Fixed: #8. Mentions #9.", "cldmv", "R")).toEqual([3, 7, 8]);
		expect(closingIssues("closes #3 and close #3", "o", "r")).toEqual([3]);
	});
});

describe("breakingHints", () => {
	it("reports each kind of hint", () => {
		expect(breakingHints("feat!: x", "BREAKING CHANGE: gone", ["semver: major"])).toEqual(["`!` in the type", "BREAKING CHANGE in the body", "semver: major label"]);
		expect(breakingHints("feat: x", "BREAKING-CHANGES listed", [])).toEqual(["BREAKING CHANGE in the body"]);
		expect(breakingHints("feat: x", "", ["type: feature"])).toEqual([]);
	});
});

describe("sectionFor", () => {
	const s = (title: string, labels: string[] = [], author = "me", breaking: string[] = []) => sectionFor({ title, labels, author, breaking });
	it("puts breaking first, then security", () => {
		expect(s("fix: x", ["security"], "me", ["`!` in the type"])).toBe("breaking");
		expect(s("security: x")).toBe("security");
		expect(s("fix(security): x", ["type: bug"])).toBe("security");
		expect(s("fix: x", ["Security"])).toBe("security");
	});
	it("maps types", () => {
		expect(s("feat: x")).toBe("features");
		expect(s("fix: x")).toBe("fixes");
		expect(s("deps: x")).toBe("dependencies");
		expect(s("chore(deps): x")).toBe("dependencies");
		expect(s("build(deps-dev): x")).toBe("dependencies");
		expect(s("Bump a from 1 to 2", [], "dependabot[bot]")).toBe("dependencies");
		for (const t of ["ci", "chore", "build", "test", "style"]) expect(s(`${t}: x`)).toBe("ciTooling");
		expect(s("docs: x")).toBe("documentation");
	});
	it("maps labels", () => {
		expect(s("x", ["type: feature"])).toBe("features");
		expect(s("x", ["type: feature request"])).toBe("features");
		expect(s("x", ["type: enhancement"])).toBe("features");
		expect(s("x", ["type: bug"])).toBe("fixes");
		expect(s("x", ["type: dependencies"])).toBe("dependencies");
		expect(s("x", ["dependencies"])).toBe("dependencies");
		expect(s("x", ["type: ci"])).toBe("ciTooling");
		expect(s("x", ["type: config"])).toBe("ciTooling");
		expect(s("x", ["type: documentation"])).toBe("documentation");
		expect(s("x", ["documentation"])).toBe("documentation");
		expect(s("feat: x", ["type: feature", "priority: high"])).toBe("features");
	});
	it("leaves disagreement or silence ungrouped", () => {
		expect(s("chore: x", ["type: enhancement"])).toBeUndefined();
		expect(s("refactor: x")).toBeUndefined();
		expect(s("perf: x", ["priority: low"])).toBeUndefined();
		expect(s("Update thing")).toBeUndefined();
	});
});

describe("isGenerated / exportKeys", () => {
	it("recognises lockfiles and build output", () => {
		for (const p of ["package-lock.json", "pkg/pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json", "dist/index.mjs", "types/a.d.ts"]) expect(isGenerated(p)).toBe(true);
		for (const p of ["src/dist/x.ts", "package.json", "src/types.ts"]) expect(isGenerated(p)).toBe(false);
	});
	it("lists the published subpaths", () => {
		expect(exportKeys(undefined)).toEqual([]);
		expect(exportKeys(null)).toEqual([]);
		expect(exportKeys("./a.mjs")).toEqual(["."]);
		expect(exportKeys(["./a.mjs"])).toEqual(["."]);
		expect(exportKeys({ import: "./a.mjs", require: "./a.cjs" })).toEqual(["."]);
		expect(exportKeys({ ".": "./a.mjs", "./b": "./b.mjs" })).toEqual([".", "./b"]);
	});
});

describe("dependencyChanges / packageJsonDelta / releaseType", () => {
	it("diffs direct deps per scope with locked versions from either lockfile format", () => {
		const from = { dependencies: { a: "^1" }, peerDependencies: { p: "^1" } };
		const to = { dependencies: { a: "^1" }, optionalDependencies: { o: "^1" }, peerDependencies: { p: "^2" } };
		expect(dependencyChanges(from, to, { dependencies: { a: { version: "1.0.0" } } }, { packages: { "node_modules/a": { version: "1.0.1" } } })).toEqual([
			{ name: "a", scope: "runtime", change: "changed", from: "^1", to: "^1", lockedFrom: "1.0.0", lockedTo: "1.0.1" },
			{ name: "o", scope: "optional", change: "added", to: "^1" },
			{ name: "p", scope: "peer", change: "changed", from: "^1", to: "^2" }
		]);
		expect(dependencyChanges(from, from)).toEqual([]);
	});
	it("reports package.json field changes and the hints they imply", () => {
		expect(packageJsonDelta({ version: "1.0.0" }, { version: "1.0.0" })).toEqual({ delta: { changed: [] }, hints: [] });
		const { delta, hints } = packageJsonDelta({ exports: "./a.mjs", bin: "x" }, { version: "2.0.0", engines: { node: ">=22" }, exports: { "./b": "./b.mjs" } });
		expect(delta).toEqual({ changed: ["version", "engines", "exports", "bin"], version: { to: "2.0.0" }, engines: { from: undefined, to: { node: ">=22" } }, exports: { added: ["./b"], removed: ["."] } });
		expect(hints).toEqual(['engines changed: null → {"node":">=22"}', "exports entry removed: ."]);
		expect(packageJsonDelta({ version: "1.0.0", engines: { node: ">=20" } }, {}).delta.version).toEqual({ from: "1.0.0" });
		expect(packageJsonDelta({ version: "1.0.0", engines: { node: ">=20" } }, {}).hints).toEqual(['engines changed: {"node":">=20"} → null']);
	});
	it("names the bump", () => {
		expect(releaseType(null, "1.0.0")).toBeNull();
		expect(releaseType("1.0.0", undefined)).toBeNull();
		expect(releaseType("1.9.9", "2.0.0")).toBe("Major");
		expect(releaseType("1.2.3", "1.3.0")).toBe("Minor");
		expect(releaseType("1.2.3", "1.2.4-rc.1")).toBe("Patch");
	});
});

describe("buildSkeleton", () => {
	it("falls back to X.Y.Z and an empty release type, and skips empty sections", () => {
		const groups = { breaking: [], features: [], fixes: [1], security: [], ciTooling: [], documentation: [], dependencies: [], ungrouped: [] };
		const md = buildSkeleton({ repo: "CLDMV/r", pull: 9, version: null, prs: [{ number: 1, url: "u1", title: "fix: a", type: "fix", fetched: false }], groups, excluded: [], hotfixes: [] });
		expect(md).toContain("# r vX.Y.Z Changelog");
		expect(md).toContain("**Release Type**: \n");
		expect(md).toContain("## 🐛 Bug Fixes\n\n### fix: a ([#1](u1))");
		expect(md).not.toContain("## ✨ Features");
		expect(md).toContain("## Upgrade notes");
	});
});

describe("reportReleaseChanges", () => {
	it("returns the shipping PRs, exclusions, groups, hotfixes and net facts", async () => {
		const out = await run({ skeleton: true });
		expect(out).toMatchObject({ repo: "CLDMV/r", pull: 100, url: "https://github.com/CLDMV/r/pull/100", version: "1.3.0", head: "next", base: "master" });
		expect(out.previousRelease).toEqual({ version: "1.2.1", tag: "v1.2.1", pull: 90, sha: "h1", kind: "hotfix" });
		expect(out.changelog).toEqual({ path: "docs/changelog/v1/v1.3.0.md", checkedPaths: ["docs/changelog/v1/v1.3.0.md", "docs/changelogs/v1/v1.3.0.md"] });
		expect(out.prs.map((p) => p.number)).toEqual([10, 11, 15, 16]);
		expect(out.excluded).toEqual([
			{ number: 5, title: "fix: old thing", reason: "earlier-release" },
			{ number: 6, title: "feat: old other", reason: "earlier-changelog" },
			{ number: 13, title: "feat: temp", reason: "reverted", pair: 14 },
			{ number: 14, title: 'Revert "feat: temp (#13)"', reason: "revert", pair: 13 }
		]);
		expect(out.hotfixes).toEqual([{ version: "1.2.1", pull: 90, title: "release: v1.2.1 - hotfix", url: "https://github.com/CLDMV/r/pull/90", sha: "h1" }]);
		expect(out.groups).toEqual({ breaking: [], features: [10], fixes: [11], security: [], ciTooling: [], documentation: [], dependencies: [16], ungrouped: [15] });

		const [x, y, z, d] = out.prs;
		expect(x).toMatchObject({ title: "feat: add x", type: "feat", fetched: true, labels: ["type: feature"], author: "Shinrai", closes: [3, 7], documented: true, section: "features", breaking: [], body: "Closes #3, fixes other/repo#4 and resolves CLDMV/r#7" });
		expect(x).not.toHaveProperty("files");
		expect(y).toMatchObject({ title: "fix: y", type: "fix", documented: false, changedFiles: 2 });
		expect(z).toMatchObject({ scope: "core", author: "", body: "" });
		expect(z).not.toHaveProperty("section");
		expect(d).toMatchObject({ author: "dependabot[bot]", section: "dependencies" });

		expect(out.net).toEqual({
			breakingHints: ['engines changed: {"node":">=20"} → {"node":">=22"}', "exports entry removed: ./old"],
			packageJson: {
				changed: ["version", "engines", "exports"],
				version: { from: "1.2.1", to: "1.3.0" },
				engines: { from: { node: ">=20" }, to: { node: ">=22" } },
				exports: { added: ["./new"], removed: ["./old"] }
			},
			dependencies: [
				{ name: "a", scope: "runtime", change: "changed", from: "^1.0.0", to: "^1.1.0", lockedFrom: "1.0.5", lockedTo: "1.1.2" },
				{ name: "added", scope: "runtime", change: "added", to: "^3.0.0", lockedTo: "3.0.0" },
				{ name: "gone", scope: "runtime", change: "removed", from: "^1.0.0", lockedFrom: "1.0.0" },
				{ name: "d", scope: "dev", change: "changed", from: "^2.0.0", to: "^2.0.0", lockedFrom: "2.0.0", lockedTo: "2.0.1" }
			],
			files: { changed: 3, additions: 50, deletions: 10, excludingGenerated: { changed: 1, additions: 40, deletions: 5 }, complete: false }
		});
		expect(out.skeleton).toContain("# r v1.3.0 Changelog");
		expect(out.skeleton).toContain("**Release Type**: Minor");
		expect(out.skeleton).toContain("### feat: add x ([#10](https://github.com/CLDMV/r/pull/10), closes [#3](https://github.com/CLDMV/r/issues/3), closes [#7](https://github.com/CLDMV/r/issues/7))");
		expect(out.skeleton).toContain("## 🔧 Other\n\n### refactor(core): z");
		expect(out).not.toHaveProperty("truncated");
	});

	it("titles leaves bodies out; files lists files and flags a short list", async () => {
		const titles = await run({ detail: "titles" });
		expect(titles.prs[0]).not.toHaveProperty("body");
		const files = await run({ detail: "files", prs: [10, 99] });
		expect(files.notInRelease).toEqual([99]);
		expect(files.prs[0]!.files).toEqual([
			{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
			{ path: "package-lock.json", status: "modified", additions: 1, deletions: 1 },
			{ path: "assets/logo.png", status: "added", additions: 0, deletions: 0 }
		]);
		expect(files.prs[0]).not.toHaveProperty("filesTruncated");
		expect(files.prs[1]).not.toHaveProperty("body");
		expect(files.prs[1]).not.toHaveProperty("files");
		const capped = await run({ detail: "files", prs: [11], maxFiles: 999 });
		expect(capped.prs[1]).toMatchObject({ files: [], filesTruncated: true });
		expect(capped).not.toHaveProperty("notInRelease");
	});

	it("diff adds capped patches and skips generated files and anything past the total cap", async () => {
		const out = await run({ detail: "diff", prs: [10], maxPatchChars: 5 });
		expect(out.prs[0]!.files).toEqual([
			{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1", patchTruncated: true },
			{ path: "package-lock.json", status: "modified", additions: 1, deletions: 1, patchSkipped: "generated" },
			{ path: "assets/logo.png", status: "added", additions: 0, deletions: 0 }
		]);
		const two = { 10: [{ filename: "a", status: "modified", additions: 1, deletions: 0, patch: "abc" }, { filename: "b", status: "modified", additions: 1, deletions: 0, patch: "def" }] };
		const tight = await run({ detail: "diff", prs: [10], maxDiffChars: 3 }, { "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": (p) => (two as any)[p.pull_number] ?? [] });
		expect(tight.prs[0]!.files).toEqual([
			{ path: "a", status: "modified", additions: 1, deletions: 0, patch: "abc" },
			{ path: "b", status: "modified", additions: 1, deletions: 0, patchSkipped: "max-diff-chars" }
		]);
	});

	it("caps bodies", async () => {
		const out = await run({ maxBodyChars: 6 });
		expect(out.prs[0]).toMatchObject({ body: "Closes", bodyTruncated: true });
		expect(out.prs[1]).not.toHaveProperty("bodyTruncated");
	});

	it("without a version: no changelog lookup, no documented flag, X.Y.Z skeleton", async () => {
		const out = await run({ skeleton: true }, { "GET /repos/{owner}/{repo}/pulls/{pull_number}": (p) => (p.pull_number === 100 ? { ...RELEASE, title: "Release candidate" } : PRS[p.pull_number]) });
		expect(out.version).toBeNull();
		expect(out).not.toHaveProperty("changelog");
		expect(out.prs[0]).not.toHaveProperty("documented");
		expect(out.skeleton).toContain("# r vX.Y.Z Changelog");
	});

	it("a hotfix release PR does not report hotfixes, and the walk stops at the first full release", async () => {
		const out = await run({}, { "GET /repos/{owner}/{repo}/pulls/{pull_number}": (p) => (p.pull_number === 100 ? { ...RELEASE, head: { ref: "hotfixes", sha: "headsha" } } : PRS[p.pull_number]) });
		expect(out.hotfixes).toEqual([]);
		const routes = (await (async () => {
			const o = octokitWith(handler());
			await reportReleaseChanges(o, { owner: "CLDMV", repo: "r", pull: 100 });
			return o.request.mock.calls.filter((c: any[]) => c[0] === "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls").map((c: any[]) => c[1].commit_sha);
		})());
		expect(routes).toEqual(["h1", "r1"]);
	});

	it("drops a hotfix already on the head branch, and tolerates a compare with no commits", async () => {
		const out = await run({}, { "GET /repos/{owner}/{repo}/compare/{basehead}": () => ({}) });
		expect(out.hotfixes).toEqual([]);
	});

	it("treats a hotfix/* release branch as a hotfix too", async () => {
		const out = await run({}, {
			"GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls": (p) => [{ number: p.commit_sha === "h1" ? 90 : 80, title: "release", html_url: "u", head: { ref: p.commit_sha === "h1" ? "hotfix/1.2.1" : "next" } }]
		});
		expect(out.previousRelease?.kind).toBe("hotfix");
		expect(out.hotfixes.map((h) => h.pull)).toEqual([90]);
	});

	it("handles a base branch with no release commits, or a release commit with no PR or version", async () => {
		const none = await run({}, { "GET /repos/{owner}/{repo}/commits": () => [commit("feat: x", "m1")] });
		expect(none.previousRelease).toBeNull();
		expect(none.excluded.map((e) => e.reason)).toEqual(["reverted", "revert"]);
		const orphan = await run({}, { "GET /repos/{owner}/{repo}/commits": () => [commit("release: soon", "s1")], "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls": () => [] });
		expect(orphan.previousRelease).toEqual({ version: null, tag: null, sha: "s1", kind: "full" });
	});

	it("keeps a revert of something outside the range", async () => {
		const out = await run({}, { "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits": (p) => (p.pull_number === 100 ? [commit('Revert "feat: shipped long ago (#2)" (#17)')] : []) });
		expect(out.prs.map((p) => p.number)).toEqual([17]);
		expect(out.prs[0]).toMatchObject({ fetched: true, title: "chore: pr 17" });
	});

	it("leaves out package.json facts when either side has no readable package.json", async () => {
		const out = await run({}, { "GET /repos/{owner}/{repo}/contents/{path}": (p) => (p.path === "package.json" && p.ref === "master" ? "{not json" : p.path === "package.json" ? JSON.stringify(PKG_HEAD) : { type: "dir" }) });
		expect(out.net).not.toHaveProperty("packageJson");
		expect(out.net).not.toHaveProperty("dependencies");
		expect(out.changelog?.path).toBeNull();
		const noHead = await run({}, { "GET /repos/{owner}/{repo}/contents/{path}": (p) => (p.path === "package.json" && p.ref === "master" ? JSON.stringify(PKG_BASE) : { type: "dir" }) });
		expect(noHead.net).not.toHaveProperty("packageJson");
	});

	it("runs out of budget on a file read and still truncates", async () => {
		// The 9th call is the first changelog lookup.
		const out = await run({ maxApiCalls: 8 });
		expect(out).toMatchObject({ truncated: true, truncatedReason: "max-api-calls", prs: [] });
		expect(out.hotfixes).toHaveLength(1);
	});

	it("returns partial results flagged max-api-calls, grouping unfetched PRs by their commit title", async () => {
		// pull, commits, base commits, 2× (assoc + commits), compare, prev changelog ×2, current changelog = 11 calls, then one PR.
		const out = await run({ maxApiCalls: 12 });
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("max-api-calls");
		expect(out.prs.map((p) => p.fetched)).toEqual([true, false, false, false]);
		expect(out.groups).toMatchObject({ features: [10], dependencies: [16], ungrouped: [11, 15] });
		expect(out).not.toHaveProperty("net");
	});

	it("stops with rate-limited and passes retryAfterSeconds through when GitHub sent it", async () => {
		const limited = (headers: Record<string, string>) => octokitWith(async () => {
			throw Object.assign(new Error("Forbidden"), { status: 403, response: { headers } });
		});
		const a = await reportReleaseChanges(limited({ "retry-after": "30" }), { owner: "CLDMV", repo: "r", pull: 100, skeleton: true });
		expect(a).toMatchObject({ truncated: true, truncatedReason: "rate-limited", retryAfterSeconds: 30, prs: [] });
		expect(a).not.toHaveProperty("skeleton");
		const b = await reportReleaseChanges(limited({ "x-ratelimit-remaining": "0" }), { owner: "CLDMV", repo: "r", pull: 100 });
		expect(b.truncatedReason).toBe("rate-limited");
		expect(b).not.toHaveProperty("retryAfterSeconds");
	});

	it("rate limiting during a file read still truncates rather than reading as missing", async () => {
		const out = await reportReleaseChanges(
			octokitWith(async (route, p) => {
				if (route === "GET /repos/{owner}/{repo}/contents/{path}") throw status(429, "Too Many Requests");
				return handler()(route, p);
			}),
			{ owner: "CLDMV", repo: "r", pull: 100 }
		);
		expect(out.truncatedReason).toBe("rate-limited");
		expect(out.prs).toEqual([]);
	});

	it("propagates a non-404 error from a file read, and a missing release PR", async () => {
		await expect(run({}, { "GET /repos/{owner}/{repo}/contents/{path}": () => { throw status(500, "server exploded"); } })).rejects.toThrow("server exploded");
		await expect(run({ pull: 404 })).rejects.toThrow("Not Found");
	});

	it("clamps maxApiCalls to the hard cap", async () => {
		const out = await run({ maxApiCalls: 999999 });
		expect(out).not.toHaveProperty("truncated");
	});

	it("advertises a valid schema", () => {
		expect(REPORT_RELEASE_CHANGES_SCHEMA.required).toEqual(["owner", "repo", "pull"]);
		expect(REPORT_RELEASE_CHANGES_SCHEMA.additionalProperties).toBe(false);
		expect(REPORT_RELEASE_CHANGES_SCHEMA.properties.detail.enum).toEqual(["titles", "summaries", "files", "diff"]);
	});
});
