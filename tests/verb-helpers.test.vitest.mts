import { describe, it, expect, vi } from "vitest";
import { reportSecurityAlerts } from "../src/verbs/report_security_alerts.ts";
import { reportReleasePrs } from "../src/verbs/report_release_prs.ts";
import { classifyRepo } from "../src/verbs/repo-tier.ts";
import { CallBudget } from "../src/verbs/rest-client.ts";
import { commitType, releaseCommitPrs, mentionedPrs, classifyOpenPr, assessFreshness, decideVerdict, analyzeRelease } from "../src/verbs/release-analysis.ts";

type Handler = (route: string, params: any) => Promise<{ data: unknown; headers?: Record<string, string> }>;
const octokitWith = (h: Handler): any => ({ request: vi.fn(h) });
const status = (code: number) => Object.assign(new Error("x"), { status: code });
const b64 = (t: string) => ({ data: { content: Buffer.from(t).toString("base64"), encoding: "base64" }, headers: {} });

const dep = (n: number, repo: string, severity: string, over: Record<string, unknown> = {}) => ({
	number: n,
	html_url: "u",
	created_at: "t",
	repository: { full_name: `CLDMV/${repo}` },
	security_vulnerability: { severity },
	security_advisory: { summary: "s" },
	...over
});

describe("report_security_alerts — summaryOnly / filters / roll-up", () => {
	const org = (alerts: unknown[]): Handler => async (route) => ({ data: route.includes("dependabot") ? alerts : [], headers: {} });

	it("rolls alerts up per repo, worst first, and counts severities", async () => {
		const o = octokitWith(org([dep(1, "a", "low"), dep(2, "b", "critical"), dep(3, "b", "high"), dep(4, "a", "medium"), dep(5, "a", "weird")]));
		const out = await reportSecurityAlerts(o, { owner: "cldmv" });
		expect(out.byRepo.map((r) => [r.repo, r.total, r.critical, r.high, r.medium, r.low])).toEqual([
			["CLDMV/b", 2, 1, 1, 0, 0],
			["CLDMV/a", 3, 0, 0, 1, 1]
		]);
		expect(out.byRepo[0]).toMatchObject({ dependabot: 2, codeql: 0, secrets: 0 });
	});

	it("summaryOnly drops the alert list but keeps roll-up, counts and reports how many were left out", async () => {
		const o = octokitWith(org([dep(1, "a", "high"), dep(2, "a", "high")]));
		const out = await reportSecurityAlerts(o, { owner: "cldmv", summaryOnly: true });
		expect(out.alerts).toEqual([]);
		expect(out.alertsOmitted).toBe(2);
		expect(out.byRepo[0]).toMatchObject({ repo: "CLDMV/a", total: 2 });
		expect(out.counts.dependabot).toEqual({ high: 2 });
	});

	it("minSeverity keeps alerts at or above it and always keeps secret alerts", async () => {
		const o = octokitWith(async (route) => {
			if (route.includes("dependabot")) return { data: [dep(1, "a", "low"), dep(2, "a", "high"), dep(3, "a", "medium")], headers: {} };
			if (route.includes("secret-scanning")) return { data: [{ number: 9, html_url: "u", created_at: "t", repository: { full_name: "CLDMV/a" } }], headers: {} };
			return { data: [], headers: {} };
		});
		const out = await reportSecurityAlerts(o, { owner: "cldmv", minSeverity: "high" });
		expect(out.alerts.map((a) => `${a.type}:${a.number}`).sort()).toEqual(["dependabot:2", "secrets:9"]);
		const med = await reportSecurityAlerts(o, { owner: "cldmv", minSeverity: "medium" });
		expect(med.alerts.filter((a) => a.type === "dependabot").map((a) => a.number).sort()).toEqual([2, 3]);
		const low = await reportSecurityAlerts(o, { owner: "cldmv", minSeverity: "low" });
		expect(low.alerts.filter((a) => a.type === "dependabot")).toHaveLength(3);
	});

	it("repos filters by name, with or without the owner prefix, case-insensitively", async () => {
		const o = octokitWith(org([dep(1, "a", "high"), dep(2, "b", "high"), dep(3, "c", "high")]));
		const out = await reportSecurityAlerts(o, { owner: "cldmv", repos: ["CLDMV/A", "c"] });
		expect(out.byRepo.map((r) => r.repo).sort()).toEqual(["CLDMV/a", "CLDMV/c"]);
	});

	it("classify adds each repo's tier and signals", async () => {
		const o = octokitWith(async (route, p) => {
			if (route === "GET /orgs/{owner}/dependabot/alerts") return { data: [dep(1, "v4repo", "high"), dep(2, "old", "high")], headers: {} };
			if (route.startsWith("GET /orgs/")) return { data: [], headers: {} };
			if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "master" }, headers: {} };
			if (route.endsWith("/contents/{path}")) {
				if (p.repo === "old") throw status(404);
				return { data: {}, headers: {} };
			}
			if (route.endsWith("/branches/{branch}")) return { data: { commit: { sha: p.branch === "dev" ? "d" : "m" } }, headers: {} };
			throw new Error(route);
		});
		const out = await reportSecurityAlerts(o, { owner: "cldmv", classify: true });
		const by = Object.fromEntries(out.byRepo.map((r) => [r.repo, r.tier]));
		expect(by).toEqual({ "CLDMV/v4repo": "dev-trunk", "CLDMV/old": "non-v4" });
	});

	it("classify stops cleanly when the call budget runs out", async () => {
		const o = octokitWith(async (route) => {
			if (route === "GET /orgs/{owner}/dependabot/alerts") return { data: [dep(1, "a", "high")], headers: {} };
			if (route.startsWith("GET /orgs/")) return { data: [], headers: {} };
			return { data: { default_branch: "master" }, headers: {} };
		});
		const out = await reportSecurityAlerts(o, { owner: "cldmv", classify: true, maxApiCalls: 4 });
		expect(out.truncatedReason).toBe("max-api-calls");
		expect(out.byRepo[0]!.tier).toBeUndefined();
	});

	it("classify reports a rate limit and keeps what it has", async () => {
		const o = octokitWith(async (route) => {
			if (route === "GET /orgs/{owner}/dependabot/alerts") return { data: [dep(1, "a", "high")], headers: {} };
			if (route.startsWith("GET /orgs/")) return { data: [], headers: {} };
			throw Object.assign(new Error("x"), { status: 429 });
		});
		const out = await reportSecurityAlerts(o, { owner: "cldmv", classify: true });
		expect(out.truncatedReason).toBe("rate-limited");
	});

	it("classify propagates an unexpected error", async () => {
		const o = octokitWith(async (route) => {
			if (route === "GET /orgs/{owner}/dependabot/alerts") return { data: [dep(1, "a", "high")], headers: {} };
			if (route.startsWith("GET /orgs/")) return { data: [], headers: {} };
			throw status(500);
		});
		await expect(reportSecurityAlerts(o, { owner: "cldmv", classify: true })).rejects.toThrow();
	});
});

describe("classifyRepo", () => {
	const make = (opts: { workflow: boolean; next?: string; dev?: string; def?: string }) =>
		octokitWith(async (route, p) => {
			if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "master" }, headers: {} };
			if (route.endsWith("/contents/{path}")) {
				if (!opts.workflow) throw status(404);
				return { data: {}, headers: {} };
			}
			const sha: Record<string, string | undefined> = { master: opts.def ?? "m", next: opts.next, dev: opts.dev };
			if (!sha[p.branch]) throw status(404);
			return { data: { commit: { sha: sha[p.branch] } }, headers: {} };
		});
	const run = (o: any) => classifyRepo(o, new CallBudget(50), "cldmv", "r");

	it("non-v4 when the release workflow is missing, even with next/hotfixes branches", async () => {
		const out = await run(make({ workflow: false, next: "m" }));
		expect(out).toEqual({ tier: "non-v4", signals: { v4Workflow: false, defaultBranch: "master" } });
	});
	it("v4 for a normal staging-flow repo (next ahead of master)", async () => {
		expect((await run(make({ workflow: true, next: "n" }))).tier).toBe("v4");
	});
	it("v4 when next equals master and there is no dev branch", async () => {
		expect((await run(make({ workflow: true, next: "m" }))).tier).toBe("v4");
	});
	it("dev-trunk when dev differs and next is scaffold-only (equal to master)", async () => {
		const out = await run(make({ workflow: true, next: "m", dev: "d" }));
		expect(out.tier).toBe("dev-trunk");
		expect(out.signals).toMatchObject({ dev: true, nextEqualsDefault: true, devDiffersFromDefault: true });
	});
	it("dev-trunk when next is missing entirely", async () => {
		expect((await run(make({ workflow: true, dev: "d" }))).tier).toBe("dev-trunk");
	});
	it("v4 when a dev branch exists but next carries real work", async () => {
		expect((await run(make({ workflow: true, next: "n", dev: "d" }))).tier).toBe("v4");
	});
	it("copes with a repo whose info can't be read", async () => {
		const o = octokitWith(async (route) => {
			if (route === "GET /repos/{owner}/{repo}") throw status(404);
			throw status(404);
		});
		expect((await run(o)).tier).toBe("non-v4");
	});
	it("propagates a non-404 error", async () => {
		await expect(run(octokitWith(async () => { throw status(500); }))).rejects.toThrow();
	});
});

describe("release-analysis helpers", () => {
	it("commitType reads conventional prefixes", () => {
		expect(commitType("fix(cjs)!: x")).toBe("fix");
		expect(commitType("Docs: x")).toBe("docs");
		expect(commitType("plain subject")).toBe("");
	});

	it("releaseCommitPrs takes PR numbers from the first line only and drops docs and bumps", () => {
		const out = releaseCommitPrs([
			"fix(a): thing (#10)\n\nbody mentions #99",
			"fix(a): thing (#10)",
			"docs: notes (#11)",
			"chore: bump version to 1.2.3",
			"ci: sync (#12)",
			"Merge pull request #13 from x/y",
			"Merge branch 'next' into foo",
			"fix(b): branch commit with no number",
			"deps: bump x (#14)"
		]);
		expect(out).toEqual([
			{ number: 10, title: "fix(a): thing", type: "fix" },
			{ number: 12, title: "ci: sync", type: "ci" },
			{ number: 13, title: "Merge pull request #13 from x/y", type: "" },
			{ number: 14, title: "deps: bump x", type: "deps" }
		]);
	});

	it("mentionedPrs finds #N and /pull/N", () => {
		expect([...mentionedPrs("see #4, [x](https://github.com/o/r/pull/7) and #12.")].sort((a, b) => a - b)).toEqual([4, 7, 12]);
	});

	it("classifyOpenPr sorts doc, dependency, feature and draft", () => {
		const base = { number: 1, html_url: "u" };
		expect(classifyOpenPr({ ...base, title: "docs: v1.2.3 release notes" })).toMatchObject({ kind: "doc", version: "1.2.3" });
		expect(classifyOpenPr({ ...base, title: "x", head: { ref: "docs/foo" } }).kind).toBe("doc");
		expect(classifyOpenPr({ ...base, title: "deps: bump" }).kind).toBe("dependency");
		expect(classifyOpenPr({ ...base, title: "x", labels: [{ name: "type: dependencies" }] }).kind).toBe("dependency");
		expect(classifyOpenPr({ ...base, title: "x", user: { login: "dependabot[bot]" } }).kind).toBe("dependency");
		expect(classifyOpenPr({ ...base, title: "feat: y" }).kind).toBe("feature");
		expect(classifyOpenPr({ ...base, title: "feat: y", draft: true }).kind).toBe("draft");
		expect(classifyOpenPr({ ...base, title: "docs: no version" }).version).toBeUndefined();
	});

	const long = "# P v1.2.3 Changelog\n\n## Overview\n\n" + "text ".repeat(100);
	const commits = [
		{ number: 1, title: "fix: a", type: "fix" },
		{ number: 2, title: "ci: b", type: "ci" }
	];
	it("assessFreshness: current, minor-gap, stale, version-drift, thin", () => {
		const readme = "### Latest: v1.2.3 (October 2026)";
		expect(assessFreshness("1.2.3", `${long} #1 #2`, commits, readme)).toMatchObject({ status: "current", readmeMentionsVersion: true, expectedPrs: 2 });
		expect(assessFreshness("1.2.3", `${long} #1`, commits, readme)).toMatchObject({ status: "minor-gap", missingInternal: [{ number: 2, title: "ci: b" }] });
		expect(assessFreshness("1.2.3", `${long} #2`, commits, readme)).toMatchObject({ status: "stale", missingUserFacing: [{ number: 1, title: "fix: a" }] });
		expect(assessFreshness("1.2.4", `${long} #1 #2`, commits, readme)).toMatchObject({ status: "version-drift", headingMatchesVersion: false });
		expect(assessFreshness("1.2.3", "# P v1.2.3 Changelog\n#1 #2", commits, undefined)).toMatchObject({ status: "thin", readmeMentionsVersion: false });
	});

	const fresh = (status: any, internal = 0): any => ({ status, expectedPrs: 1, missingUserFacing: [], missingInternal: new Array(internal).fill({ number: 1, title: "x" }), headingMatchesVersion: true, readmeMentionsVersion: true });
	const pr = (kind: any, number = 5, version?: string): any => ({ number, title: "t", url: "u", kind, ...(version ? { version } : {}) });
	it("decideVerdict walks the decision table", () => {
		expect(decideVerdict({ hasChangelog: false, unknownVersion: true, openPrs: [], version: null }).verdict).toBe("inspect");
		expect(decideVerdict({ hasChangelog: true, unknownVersion: false, freshness: fresh("current"), openPrs: [pr("feature")], version: "1.0.0" }).verdict).toBe("done");
		expect(decideVerdict({ hasChangelog: true, unknownVersion: false, freshness: fresh("minor-gap", 2), openPrs: [], version: "1.0.0" })).toMatchObject({ verdict: "done", reason: expect.stringContaining("2 internal") });
		expect(decideVerdict({ hasChangelog: false, unknownVersion: false, openPrs: [pr("doc", 7, "1.0.0"), pr("feature")], version: "1.0.0" })).toMatchObject({ verdict: "in-flight" });
		expect(decideVerdict({ hasChangelog: false, unknownVersion: false, openPrs: [pr("doc", 7, "0.9.0")], version: "1.0.0" })).toMatchObject({ verdict: "in-flight", docVersionMismatch: true });
		expect(decideVerdict({ hasChangelog: false, unknownVersion: false, openPrs: [pr("feature")], version: "1.0.0" }).verdict).toBe("wait");
		expect(decideVerdict({ hasChangelog: false, unknownVersion: false, openPrs: [pr("dependency"), pr("draft")], version: "1.0.0" }).verdict).toBe("gray");
		expect(decideVerdict({ hasChangelog: false, unknownVersion: false, openPrs: [], version: "1.0.0" }).verdict).toBe("write");
		expect(decideVerdict({ hasChangelog: true, unknownVersion: false, freshness: fresh("stale"), openPrs: [], version: "1.0.0" }).verdict).toBe("update");
		expect(decideVerdict({ hasChangelog: true, unknownVersion: false, freshness: fresh("version-drift"), openPrs: [pr("feature")], version: "1.0.0" }).verdict).toBe("wait");
	});
});

describe("report_release_prs analyze", () => {
	const hit = { number: 5, title: "release: v1.2.3 - x", html_url: "https://github.com/CLDMV/r/pull/5", repository_url: "https://api.github.com/repos/CLDMV/r" };
	const changelog = "# P v1.2.3 Changelog\n\n## Overview\n\n" + "text ".repeat(100) + " #10";
	const handler = (over: Partial<Record<string, any>> = {}): Handler => async (route, p) => {
		if (route in over) return over[route];
		if (route === "GET /search/issues") return { data: { total_count: 1, incomplete_results: false, items: [hit] }, headers: {} };
		if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { data: { head: { ref: "next" }, base: { ref: "master" } }, headers: {} };
		if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [], headers: {} };
		if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits") return { data: [{ commit: { message: "fix: a (#10)" } }, { commit: { message: "fix: b (#11)" } }], headers: {} };
		if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
			if (p.path === "README.md") return b64("### Latest: v1.2.3");
			if (p.path.startsWith("docs/changelog/")) return b64(changelog);
			throw status(404);
		}
		throw new Error(route);
	};

	it("without analyze nothing extra is fetched or returned", async () => {
		const o = octokitWith(handler());
		const out = await reportReleasePrs(o, { owner: "cldmv" });
		expect(out.releasePrs[0]).not.toHaveProperty("analysis");
		expect(out).not.toHaveProperty("verdicts");
		expect(o.request.mock.calls.map((c: any[]) => c[0])).not.toContain("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits");
	});

	it("flags a ready-but-stale changelog and tallies verdicts", async () => {
		const out = await reportReleasePrs(octokitWith(handler()), { owner: "cldmv", analyze: true });
		const a = out.releasePrs[0]!.analysis!;
		expect(out.releasePrs[0]!.status).toBe("ready");
		expect(a.freshness).toMatchObject({ status: "stale", missingUserFacing: [{ number: 11, title: "fix: b" }] });
		expect(a.verdict).toBe("update");
		expect(out.verdicts).toEqual({ update: 1 });
	});

	it("onlyMissing with analyze keeps a ready-but-stale PR and drops a done one", async () => {
		const stale = await reportReleasePrs(octokitWith(handler()), { owner: "cldmv", analyze: true, onlyMissing: true });
		expect(stale.releasePrs).toHaveLength(1);
		const done = handler({ "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits": { data: [{ commit: { message: "fix: a (#10)" } }], headers: {} } });
		const out = await reportReleasePrs(octokitWith(done), { owner: "cldmv", analyze: true, onlyMissing: true });
		expect(out.releasePrs).toEqual([]);
		expect(out.verdicts).toEqual({ done: 1 });
	});

	it("needs-changelog with an open feature PR waits; a doc PR is in flight", async () => {
		const wait = async (route: string, p: any) => {
			if (route === "GET /repos/{owner}/{repo}/contents/{path}") throw status(404);
			if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [{ number: 20, title: "feat: z", html_url: "u", head: { ref: "feat/z" } }], headers: {} };
			return handler()(route, p);
		};
		const out = await reportReleasePrs(octokitWith(wait), { owner: "cldmv", analyze: true });
		expect(out.releasePrs[0]!.analysis).toMatchObject({ verdict: "wait", openPrs: [{ number: 20, kind: "feature" }] });
		const flight = async (route: string, p: any) => {
			if (route === "GET /repos/{owner}/{repo}/contents/{path}") throw status(404);
			if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [{ number: 21, title: "docs: v1.2.3 changelog", html_url: "u", head: { ref: "docs/x" } }], headers: {} };
			return handler()(route, p);
		};
		const f = await reportReleasePrs(octokitWith(flight), { owner: "cldmv", analyze: true });
		expect(f.releasePrs[0]!.analysis).toMatchObject({ verdict: "in-flight" });
	});

	it("an unknown version is analysed as inspect without reading a changelog", async () => {
		const o = octokitWith(async (route, p) => {
			if (route === "GET /search/issues") return { data: { total_count: 1, incomplete_results: false, items: [{ ...hit, title: "Release soon" }] }, headers: {} };
			return handler()(route, p);
		});
		const out = await reportReleasePrs(o, { owner: "cldmv", analyze: true });
		expect(out.releasePrs[0]!.analysis!.verdict).toBe("inspect");
	});

	it("keeps the PR's status when the budget runs out mid-analysis", async () => {
		const out = await reportReleasePrs(octokitWith(handler()), { owner: "cldmv", analyze: true, maxApiCalls: 4 });
		expect(out.truncatedReason).toBe("max-api-calls");
		expect(out.releasePrs[0]!.status).toBe("ready");
		expect(out.releasePrs[0]!.analysis).toBeUndefined();
	});

	it("analyzeRelease tolerates a missing README and a non-base64 body", async () => {
		const o = octokitWith(async (route, p) => {
			if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
				if (p.path === "README.md") throw status(404);
				return { data: { content: changelog + " #11", encoding: "utf-8" }, headers: {} };
			}
			return handler()(route, p);
		});
		const a = await analyzeRelease(o, new CallBudget(50), { owner: "CLDMV", repo: "r", pull: 5, head: "next", version: "1.2.3", changelogPath: "docs/changelog/v1/v1.2.3.md" });
		expect(a.freshness).toMatchObject({ status: "current", readmeMentionsVersion: false });
		const empty = octokitWith(async (route, p) => (route === "GET /repos/{owner}/{repo}/contents/{path}" ? { data: {}, headers: {} } : handler()(route, p)));
		const b = await analyzeRelease(empty, new CallBudget(50), { owner: "CLDMV", repo: "r", pull: 5, head: "next", version: "1.2.3", changelogPath: "x" });
		expect(b.freshness!.status).toBe("version-drift");
	});

	it("propagates a non-404 error from a content read", async () => {
		const o = octokitWith(async (route, p) => {
			if (route === "GET /repos/{owner}/{repo}/contents/{path}" && p.path === "README.md") throw status(500);
			return handler()(route, p);
		});
		await expect(reportReleasePrs(o, { owner: "cldmv", analyze: true })).rejects.toThrow();
	});
});
