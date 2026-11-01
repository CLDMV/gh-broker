import { describe, it, expect, vi } from "vitest";
import { reportReleasePrs, parseReleaseVersion, changelogPaths, REPORT_RELEASE_PRS_SCHEMA } from "../src/verbs/report_release_prs.ts";

type Handler = (route: string, params: any) => Promise<{ data: unknown; headers?: Record<string, string> }>;

function octokitWith(handler: Handler): any {
	return { request: vi.fn(handler) };
}

const status = (code: number, message = "x") => Object.assign(new Error(message), { status: code });

const hit = (repo: string, number: number, title: string, over: Record<string, unknown> = {}) => ({
	number,
	title,
	html_url: `https://github.com/CLDMV/${repo}/pull/${number}`,
	repository_url: `https://api.github.com/repos/CLDMV/${repo}`,
	...over
});

const search = (items: unknown[], over: Record<string, unknown> = {}) => ({ data: { total_count: items.length, incomplete_results: false, items, ...over }, headers: {} });

const pull = (head = "next", base = "master", draft = false) => ({ data: { head: { ref: head }, base: { ref: base }, draft }, headers: {} });

describe("parseReleaseVersion", () => {
	it("reads the version out of a release title, with or without the v", () => {
		expect(parseReleaseVersion("release: v0.4.2 - bump the patch group")).toBe("0.4.2");
		expect(parseReleaseVersion("release: 1.0.0")).toBe("1.0.0");
		expect(parseReleaseVersion("Release: v2.10.13-rc.1 - x")).toBe("2.10.13-rc.1");
	});

	it("returns null when the title carries no version", () => {
		expect(parseReleaseVersion("chore: tidy up")).toBeNull();
		expect(parseReleaseVersion("release: soon")).toBeNull();
	});
});

describe("changelogPaths", () => {
	it("lists both changelog/ and changelogs/ under the major folder", () => {
		expect(changelogPaths("0.4.2")).toEqual(["docs/changelog/v0/v0.4.2.md", "docs/changelogs/v0/v0.4.2.md"]);
		expect(changelogPaths("12.3.4")).toEqual(["docs/changelog/v12/v12.3.4.md", "docs/changelogs/v12/v12.3.4.md"]);
	});
});

describe("reportReleasePrs", () => {
	it("searches the org once for open release-labelled PRs", async () => {
		const octokit = octokitWith(async () => search([]));
		const out = await reportReleasePrs(octokit, { owner: "cldmv" });
		expect(octokit.request).toHaveBeenCalledTimes(1);
		expect(octokit.request).toHaveBeenCalledWith("GET /search/issues", { q: "org:cldmv is:pr is:open label:release", per_page: 100 });
		expect(out).toEqual({ scanned: { releasePrs: 0 }, summary: { ready: 0, needsChangelog: 0, unknownVersion: 0 }, releasePrs: [] });
	});

	it("scopes the search to one repo when repo is given", async () => {
		const octokit = octokitWith(async () => search([]));
		await reportReleasePrs(octokit, { owner: "cldmv", repo: "gh-broker" });
		expect(octokit.request.mock.calls[0]![1].q).toBe("repo:cldmv/gh-broker is:pr is:open label:release");
	});

	it("marks a PR ready when the changelog exists at the PR head commit, and stops at the first path found", async () => {
		const octokit = octokitWith(async (route, params) => {
			if (route === "GET /search/issues") return search([hit("gh-broker", 88, "release: v0.4.2 - stuff")]);
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pull("next", "master");
			if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
				expect(params).toMatchObject({ owner: "CLDMV", repo: "gh-broker", ref: "next", path: "docs/changelog/v0/v0.4.2.md" });
				return { data: { type: "file" }, headers: {} };
			}
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportReleasePrs(octokit, { owner: "cldmv" });
		expect(out.releasePrs).toEqual([
			{
				repo: "CLDMV/gh-broker",
				pull: 88,
				url: "https://github.com/CLDMV/gh-broker/pull/88",
				title: "release: v0.4.2 - stuff",
				version: "0.4.2",
				head: "next",
				base: "master",
				draft: false,
				status: "ready",
				changelogPath: "docs/changelog/v0/v0.4.2.md"
			}
		]);
		expect(out.summary).toEqual({ ready: 1, needsChangelog: 0, unknownVersion: 0 });
		expect(octokit.request).toHaveBeenCalledTimes(3);
	});

	it("falls through to docs/changelogs/ when docs/changelog/ 404s", async () => {
		const octokit = octokitWith(async (route, params) => {
			if (route === "GET /search/issues") return search([hit("r", 1, "release: v1.2.3")]);
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pull();
			if (params.path === "docs/changelog/v1/v1.2.3.md") throw status(404, "Not Found");
			return { data: {}, headers: {} };
		});
		const out = await reportReleasePrs(octokit, { owner: "cldmv" });
		expect(out.releasePrs[0]).toMatchObject({ status: "ready", changelogPath: "docs/changelogs/v1/v1.2.3.md" });
	});

	it("marks a PR needs-changelog and lists the paths it checked when neither exists", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /search/issues") return search([hit("r", 4, "release: v0.1.0 - x")]);
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pull();
			throw status(404, "Not Found");
		});
		const out = await reportReleasePrs(octokit, { owner: "cldmv" });
		expect(out.releasePrs[0]).toMatchObject({ status: "needs-changelog", version: "0.1.0", checkedPaths: ["docs/changelog/v0/v0.1.0.md", "docs/changelogs/v0/v0.1.0.md"] });
		expect(out.releasePrs[0]).not.toHaveProperty("changelogPath");
		expect(out.summary).toEqual({ ready: 0, needsChangelog: 1, unknownVersion: 0 });
	});

	it("marks a PR unknown-version, without looking for a changelog, when the title has no version", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /search/issues") return search([hit("r", 6, "Release candidate")]);
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pull("hotfixes", "master");
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportReleasePrs(octokit, { owner: "cldmv" });
		expect(out.releasePrs[0]).toMatchObject({ status: "unknown-version", version: null, head: "hotfixes" });
		expect(octokit.request).toHaveBeenCalledTimes(2);
	});

	it("covers hotfixes release PRs across several repos and counts each status", async () => {
		const octokit = octokitWith(async (route, params) => {
			if (route === "GET /search/issues") {
				return search([hit("a", 1, "release: v1.0.1 - x"), hit("b", 2, "release: v2.0.0 - y"), hit("c", 3, "no version here")]);
			}
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pull(params.repo === "a" ? "hotfixes" : "next");
			if (params.repo === "a") return { data: {}, headers: {} };
			throw status(404);
		});
		const out = await reportReleasePrs(octokit, { owner: "cldmv" });
		expect(out.summary).toEqual({ ready: 1, needsChangelog: 1, unknownVersion: 1 });
		expect(out.releasePrs.map((p) => `${p.repo}:${p.head}:${p.status}`)).toEqual(["CLDMV/a:hotfixes:ready", "CLDMV/b:next:needs-changelog", "CLDMV/c:next:unknown-version"]);
	});

	it("onlyMissing drops ready PRs from the list but keeps the summary counts", async () => {
		const octokit = octokitWith(async (route, params) => {
			if (route === "GET /search/issues") return search([hit("a", 1, "release: v1.0.1"), hit("b", 2, "release: v2.0.0")]);
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pull();
			if (params.repo === "a") return { data: {}, headers: {} };
			throw status(404);
		});
		const out = await reportReleasePrs(octokit, { owner: "cldmv", onlyMissing: true });
		expect(out.releasePrs.map((p) => p.repo)).toEqual(["CLDMV/b"]);
		expect(out.summary).toEqual({ ready: 1, needsChangelog: 1, unknownVersion: 0 });
	});

	it("reports draft from the pull, falling back to the search hit", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /search/issues") return search([hit("a", 1, "release: v1.0.0", { draft: true })]);
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { data: { head: { ref: "next" }, base: { ref: "master" } }, headers: {} };
			return { data: {}, headers: {} };
		});
		expect((await reportReleasePrs(octokit, { owner: "cldmv" })).releasePrs[0]!.draft).toBe(true);
		const plain = octokitWith(async (route) => {
			if (route === "GET /search/issues") return search([hit("a", 1, "release: v1.0.0")]);
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { data: { head: { ref: "next" }, base: { ref: "master" } }, headers: {} };
			return { data: {}, headers: {} };
		});
		expect((await reportReleasePrs(plain, { owner: "cldmv" })).releasePrs[0]!.draft).toBe(false);
	});

	it("flags max-results when the search has more hits than one page returned", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /search/issues") return search([hit("a", 1, "release: v1.0.0")], { total_count: 150 });
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pull();
			return { data: {}, headers: {} };
		});
		const out = await reportReleasePrs(octokit, { owner: "cldmv" });
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("max-results");
		expect(out.releasePrs).toHaveLength(1);
	});

	it("flags incomplete-search when GitHub says the search timed out", async () => {
		const octokit = octokitWith(async () => search([], { incomplete_results: true }));
		const out = await reportReleasePrs(octokit, { owner: "cldmv" });
		expect(out.truncatedReason).toBe("incomplete-search");
	});

	it("returns what it has, flagged max-api-calls, when the call budget runs out", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /search/issues") return search([hit("a", 1, "release: v1.0.0"), hit("b", 2, "release: v2.0.0")]);
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pull();
			return { data: {}, headers: {} };
		});
		// search (1) + pull (2) + contents (3) for the first PR, then the second PR's pull lookup is over budget.
		const out = await reportReleasePrs(octokit, { owner: "cldmv", maxApiCalls: 3 });
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("max-api-calls");
		expect(out.releasePrs).toHaveLength(1);
		expect(out.scanned).toEqual({ releasePrs: 2 });
	});

	it("returns partial results with retryAfterSeconds when rate limited", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /search/issues") return search([hit("a", 1, "release: v1.0.0")]);
			throw Object.assign(new Error("Forbidden"), { status: 403, response: { headers: { "retry-after": "20" } } });
		});
		const out = await reportReleasePrs(octokit, { owner: "cldmv" });
		expect(out.truncatedReason).toBe("rate-limited");
		expect(out.retryAfterSeconds).toBe(20);
		expect(out.releasePrs).toEqual([]);
	});

	it("stops with rate-limited when the changelog lookup itself is rate limited", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /search/issues") return search([hit("a", 1, "release: v1.0.0")]);
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pull();
			throw status(429, "Too Many Requests");
		});
		const out = await reportReleasePrs(octokit, { owner: "cldmv" });
		expect(out.truncatedReason).toBe("rate-limited");
	});

	it("omits retryAfterSeconds when GitHub sent none", async () => {
		const octokit = octokitWith(async () => { throw status(429, "Too Many Requests"); });
		const out = await reportReleasePrs(octokit, { owner: "cldmv" });
		expect(out.truncatedReason).toBe("rate-limited");
		expect(out).not.toHaveProperty("retryAfterSeconds");
	});

	it("propagates a non-404 error from the changelog lookup instead of calling it missing", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /search/issues") return search([hit("a", 1, "release: v1.0.0")]);
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pull();
			throw status(500, "server exploded");
		});
		await expect(reportReleasePrs(octokit, { owner: "cldmv" })).rejects.toThrow("server exploded");
	});

	it("propagates a plain permission 403 on the search", async () => {
		const octokit = octokitWith(async () => { throw status(403, "Resource not accessible by personal access token"); });
		await expect(reportReleasePrs(octokit, { owner: "cldmv" })).rejects.toThrow("Resource not accessible");
	});

	it("clamps maxApiCalls to the hard cap", async () => {
		const octokit = octokitWith(async () => search([]));
		await reportReleasePrs(octokit, { owner: "cldmv", maxApiCalls: 999999 });
		expect(octokit.request).toHaveBeenCalledTimes(1);
	});

	it("advertises a valid schema", () => {
		expect(REPORT_RELEASE_PRS_SCHEMA.required).toEqual(["owner"]);
		expect(REPORT_RELEASE_PRS_SCHEMA.additionalProperties).toBe(false);
	});
});
