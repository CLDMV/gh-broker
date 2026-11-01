import { describe, it, expect, vi } from "vitest";
import { reportSecurityAlerts, REPORT_SECURITY_ALERTS_SCHEMA } from "../src/verbs/report_security_alerts.ts";

type Handler = (route: string, params: any) => Promise<{ data: unknown; headers?: Record<string, string> }>;

function octokitWith(handler: Handler): any {
	return { request: vi.fn(handler) };
}

const status = (code: number, message = "x") => Object.assign(new Error(message), { status: code });

const dependabot = (n: number, over: Record<string, unknown> = {}) => ({
	number: n,
	html_url: `https://github.com/CLDMV/r/security/dependabot/${n}`,
	created_at: "2026-10-02T20:10:30Z",
	dependency: { package: { ecosystem: "npm", name: "hono" }, manifest_path: "package-lock.json", scope: "runtime" },
	security_advisory: { ghsa_id: "GHSA-aaaa", cve_id: "CVE-2026-1", summary: "bad thing", severity: "medium" },
	security_vulnerability: { severity: "high", vulnerable_version_range: "< 4.13.7", first_patched_version: { identifier: "4.13.7" } },
	...over
});

const codeql = (n: number, over: Record<string, unknown> = {}) => ({
	number: n,
	html_url: `https://github.com/CLDMV/r/security/code-scanning/${n}`,
	created_at: "2026-10-01T00:00:00Z",
	rule: { id: "js/xss", severity: "error", security_severity_level: "critical", description: "XSS" },
	tool: { name: "CodeQL" },
	most_recent_instance: { location: { path: "src/a.ts", start_line: 12 } },
	...over
});

const secret = (n: number, over: Record<string, unknown> = {}) => ({
	number: n,
	html_url: `https://github.com/CLDMV/r/security/secret-scanning/${n}`,
	created_at: "2026-09-30T00:00:00Z",
	secret_type: "github_personal_access_token",
	secret_type_display_name: "GitHub Personal Access Token",
	validity: "active",
	secret: "ghp_SHOULD_NEVER_BE_RETURNED",
	...over
});

describe("reportSecurityAlerts — org-level reads", () => {
	it("reads the three org endpoints with state=open and normalizes each alert type", async () => {
		const octokit = octokitWith(async (route, params) => {
			expect(params).toMatchObject({ owner: "cldmv", state: "open" });
			if (route === "GET /orgs/{owner}/dependabot/alerts") return { data: [dependabot(1, { repository: { full_name: "CLDMV/a" } })], headers: {} };
			if (route === "GET /orgs/{owner}/code-scanning/alerts") return { data: [codeql(2, { repository: { full_name: "CLDMV/b" } })], headers: {} };
			if (route === "GET /orgs/{owner}/secret-scanning/alerts") return { data: [secret(3, { repository: { full_name: "CLDMV/c" } })], headers: {} };
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv" });
		expect(out.scope).toEqual({ dependabot: "org", codeql: "org", secrets: "org" });
		expect(out.scanned).toEqual({});
		expect(octokit.request).toHaveBeenCalledTimes(3);
		expect(out.alerts).toEqual([
			{
				repo: "CLDMV/b",
				type: "codeql",
				number: 2,
				severity: "critical",
				summary: "XSS",
				url: "https://github.com/CLDMV/r/security/code-scanning/2",
				createdAt: "2026-10-01T00:00:00Z",
				rule: "js/xss",
				tool: "CodeQL",
				location: "src/a.ts:12"
			},
			{
				repo: "CLDMV/a",
				type: "dependabot",
				number: 1,
				severity: "high",
				summary: "bad thing",
				url: "https://github.com/CLDMV/r/security/dependabot/1",
				createdAt: "2026-10-02T20:10:30Z",
				package: "hono",
				ecosystem: "npm",
				manifest: "package-lock.json",
				scope: "runtime",
				ghsa: "GHSA-aaaa",
				cve: "CVE-2026-1",
				vulnerableRange: "< 4.13.7",
				patchedVersion: "4.13.7"
			},
			{
				repo: "CLDMV/c",
				type: "secrets",
				number: 3,
				severity: "open",
				summary: "GitHub Personal Access Token",
				url: "https://github.com/CLDMV/r/security/secret-scanning/3",
				createdAt: "2026-09-30T00:00:00Z",
				secretType: "github_personal_access_token",
				validity: "active"
			}
		]);
		expect(out.counts).toEqual({ dependabot: { high: 1 }, codeql: { critical: 1 }, secrets: { open: 1 } });
		expect(out.truncated).toBeUndefined();
	});

	it("never returns the secret value", async () => {
		const octokit = octokitWith(async (route) => ({ data: route.includes("secret-scanning") ? [secret(1, { repository: { full_name: "CLDMV/c" } })] : [], headers: {} }));
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv", types: ["secrets"] });
		expect(JSON.stringify(out)).not.toContain("ghp_SHOULD_NEVER_BE_RETURNED");
		expect(out.alerts[0]).not.toHaveProperty("secret");
	});

	it("only reads the requested types", async () => {
		const octokit = octokitWith(async () => ({ data: [], headers: {} }));
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv", types: ["dependabot"] });
		expect(octokit.request).toHaveBeenCalledTimes(1);
		expect(octokit.request.mock.calls[0]![0]).toBe("GET /orgs/{owner}/dependabot/alerts");
		expect(out.scope).toEqual({ dependabot: "org" });
		expect(out.counts).toEqual({ dependabot: {} });
	});

	it("treats an empty types array as all three", async () => {
		const octokit = octokitWith(async () => ({ data: [], headers: {} }));
		await reportSecurityAlerts(octokit, { owner: "cldmv", types: [] });
		expect(octokit.request).toHaveBeenCalledTimes(3);
	});

	it("follows the Dependabot cursor across pages in org mode", async () => {
		const next = '<https://api.github.com/x?after=CUR>; rel="next"';
		const octokit = octokitWith(async (route, params) => {
			if (route !== "GET /orgs/{owner}/dependabot/alerts") return { data: [], headers: {} };
			if (!params.after) return { data: [dependabot(1, { repository: { full_name: "CLDMV/a" } })], headers: { link: next } };
			return { data: [dependabot(2, { repository: { full_name: "CLDMV/a" } })], headers: {} };
		});
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv", types: ["dependabot"] });
		expect(out.alerts.map((a) => a.number)).toEqual([1, 2]);
	});

	it("pages the code-scanning org endpoint with page numbers", async () => {
		const full = Array.from({ length: 100 }, (_, i) => codeql(i + 1, { repository: { full_name: "CLDMV/a" } }));
		const octokit = octokitWith(async (_route, params) => ({ data: params.page === 1 ? full : [codeql(101, { repository: { full_name: "CLDMV/a" } })], headers: {} }));
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv", types: ["codeql"] });
		expect(out.alerts).toHaveLength(101);
	});

	it("sorts by severity (critical first), then repo, then number", async () => {
		const octokit = octokitWith(async (route) => {
			if (route !== "GET /orgs/{owner}/dependabot/alerts") return { data: [], headers: {} };
			const sev = (s: string) => ({ security_vulnerability: { severity: s } });
			return {
				data: [
					dependabot(5, { repository: { full_name: "CLDMV/z" }, ...sev("low") }),
					dependabot(9, { repository: { full_name: "CLDMV/b" }, ...sev("high") }),
					dependabot(2, { repository: { full_name: "CLDMV/b" }, ...sev("high") }),
					dependabot(1, { repository: { full_name: "CLDMV/a" }, ...sev("critical") }),
					dependabot(3, { repository: { full_name: "CLDMV/a" }, ...sev("weird") })
				],
				headers: {}
			};
		});
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv", types: ["dependabot"] });
		expect(out.alerts.map((a) => `${a.repo}#${a.number}`)).toEqual(["CLDMV/a#1", "CLDMV/b#2", "CLDMV/b#9", "CLDMV/z#5", "CLDMV/a#3"]);
	});

	it("falls back to unknown severity and omits absent optional fields", async () => {
		const bare = { number: 7, html_url: "u", created_at: "t", repository: { full_name: "CLDMV/a" } };
		const octokit = octokitWith(async (route) => {
			if (route === "GET /orgs/{owner}/dependabot/alerts") return { data: [bare], headers: {} };
			if (route === "GET /orgs/{owner}/code-scanning/alerts") return { data: [{ ...bare, rule: {}, most_recent_instance: { location: { path: "x.ts" } } }], headers: {} };
			return { data: [{ ...bare }], headers: {} };
		});
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv" });
		const dep = out.alerts.find((a) => a.type === "dependabot")!;
		expect(dep).toEqual({ repo: "CLDMV/a", type: "dependabot", number: 7, severity: "unknown", summary: "", url: "u", createdAt: "t" });
		expect(out.alerts.find((a) => a.type === "codeql")).toMatchObject({ severity: "unknown", location: "x.ts" });
		expect(out.alerts.find((a) => a.type === "secrets")).toMatchObject({ severity: "open", summary: "" });
	});

	it("leaves the location off a code scanning alert whose instance has no path", async () => {
		const bare = { number: 7, html_url: "u", created_at: "t", repository: { full_name: "CLDMV/a" } };
		const octokit = octokitWith(async (route) => ({
			data: route === "GET /orgs/{owner}/code-scanning/alerts" ? [{ ...bare, most_recent_instance: { location: {} } }, { ...bare, number: 8 }] : [],
			headers: {}
		}));
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv" });
		for (const a of out.alerts.filter((x) => x.type === "codeql")) expect(a).not.toHaveProperty("location");
	});

	it("flags max-alerts when a type fills its alertLimit", async () => {
		const octokit = octokitWith(async (route) => ({ data: route.includes("dependabot") ? [dependabot(1, { repository: { full_name: "CLDMV/a" } }), dependabot(2, { repository: { full_name: "CLDMV/a" } })] : [], headers: {} }));
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv", alertLimit: 2 });
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("max-alerts");
		expect(out.alerts).toHaveLength(2);
	});
});

describe("reportSecurityAlerts — per-repo fallback", () => {
	const orgDenied = (route: string) => route.startsWith("GET /orgs/{owner}/") && !route.endsWith("/repos");

	it("falls back to a per-repo sweep for a type whose org endpoint is 403/404, keeping the types that worked", async () => {
		const octokit = octokitWith(async (route, params) => {
			if (route === "GET /orgs/{owner}/dependabot/alerts") return { data: [dependabot(1, { repository: { full_name: "CLDMV/a" } })], headers: {} };
			if (route === "GET /orgs/{owner}/code-scanning/alerts") throw status(403, "Resource not accessible by personal access token");
			if (route === "GET /orgs/{owner}/secret-scanning/alerts") throw status(404, "Not Found");
			if (route === "GET /orgs/{owner}/repos") return { data: [{ name: "a" }, { name: "b", archived: true }, { name: "c" }], headers: {} };
			if (route === "GET /repos/{owner}/{repo}/code-scanning/alerts") return { data: params.repo === "a" ? [codeql(4)] : [], headers: {} };
			if (route === "GET /repos/{owner}/{repo}/secret-scanning/alerts") return { data: params.repo === "c" ? [secret(5)] : [], headers: {} };
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv" });
		expect(out.scope).toEqual({ dependabot: "org", codeql: "per-repo", secrets: "per-repo" });
		expect(out.scanned).toEqual({ repos: 2 });
		expect(out.alerts.map((a) => `${a.type}:${a.repo}#${a.number}`).sort()).toEqual(["codeql:cldmv/a#4", "dependabot:CLDMV/a#1", "secrets:cldmv/c#5"]);
		expect(out.disabled).toBeUndefined();
	});

	it("counts repos where a type is switched off instead of failing", async () => {
		const octokit = octokitWith(async (route, params) => {
			if (orgDenied(route)) throw status(404);
			if (route === "GET /orgs/{owner}/repos") return { data: [{ name: "a" }, { name: "b" }, { name: "c" }], headers: {} };
			if (route === "GET /repos/{owner}/{repo}/dependabot/alerts") return { data: params.repo === "a" ? [dependabot(1)] : [], headers: {} };
			if (route === "GET /repos/{owner}/{repo}/code-scanning/alerts") throw status(403, "Code Security must be enabled for this repository to use code scanning.");
			if (route === "GET /repos/{owner}/{repo}/secret-scanning/alerts") {
				if (params.repo === "b") throw status(404, "Secret scanning is disabled on this repository.");
				return { data: [], headers: {} };
			}
			throw new Error(`unexpected route ${route}`);
		});
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv" });
		expect(out.disabled).toEqual({ codeql: 3, secrets: 1 });
		expect(out.alerts).toHaveLength(1);
		expect(out.counts).toEqual({ dependabot: { high: 1 }, codeql: {}, secrets: {} });
		expect(out.truncated).toBeUndefined();
	});

	it("goes straight to per-repo (no org calls) when a repo is named", async () => {
		const octokit = octokitWith(async (route, params) => {
			expect(params).toMatchObject({ owner: "cldmv", repo: "gh-broker", state: "open" });
			if (route === "GET /repos/{owner}/{repo}/dependabot/alerts") return { data: [dependabot(8)], headers: {} };
			return { data: [], headers: {} };
		});
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv", repo: "gh-broker" });
		expect(out.scanned).toEqual({ repos: 1 });
		expect(out.scope).toEqual({ dependabot: "per-repo", codeql: "per-repo", secrets: "per-repo" });
		expect(out.alerts[0]).toMatchObject({ repo: "cldmv/gh-broker", number: 8 });
		const routes = octokit.request.mock.calls.map((c: any[]) => c[0]);
		expect(routes.some((r: string) => r.startsWith("GET /orgs/"))).toBe(false);
	});

	it("flags max-repos when the owner has more repos than maxRepos, and sweeps only maxRepos", async () => {
		const octokit = octokitWith(async (route, params) => {
			if (orgDenied(route)) throw status(404);
			if (route === "GET /orgs/{owner}/repos") return { data: [{ name: "a" }, { name: "b" }, { name: "c" }], headers: {} };
			expect(["a", "b"]).toContain(params.repo);
			return { data: [], headers: {} };
		});
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv", types: ["dependabot"], maxRepos: 2 });
		expect(out.scanned).toEqual({ repos: 2 });
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("max-repos");
	});

	it("does not flag max-repos when the owner has exactly maxRepos repos", async () => {
		const octokit = octokitWith(async (route) => {
			if (orgDenied(route)) throw status(404);
			if (route === "GET /orgs/{owner}/repos") return { data: [{ name: "a" }, { name: "b" }], headers: {} };
			return { data: [], headers: {} };
		});
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv", types: ["dependabot"], maxRepos: 2 });
		expect(out.truncated).toBeUndefined();
	});

	it("flags max-alerts when one repo fills its per-type alertLimit", async () => {
		const octokit = octokitWith(async () => ({ data: [dependabot(1), dependabot(2)], headers: {} }));
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv", repo: "r", types: ["dependabot"], alertLimit: 2 });
		expect(out.truncatedReason).toBe("max-alerts");
	});
});

describe("reportSecurityAlerts — limits and errors", () => {
	it("returns partial results flagged max-api-calls when the call budget runs out", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /orgs/{owner}/dependabot/alerts") return { data: [dependabot(1, { repository: { full_name: "CLDMV/a" } })], headers: {} };
			return { data: [], headers: {} };
		});
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv", maxApiCalls: 1 });
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("max-api-calls");
		expect(out.alerts).toHaveLength(1);
		// types never reached are not reported as having zero alerts
		expect(out.counts).toEqual({ dependabot: { high: 1 } });
		expect(out.scope).toEqual({ dependabot: "org" });
	});

	it("returns partial results with retryAfterSeconds when rate limited mid-scan", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /orgs/{owner}/dependabot/alerts") return { data: [dependabot(1, { repository: { full_name: "CLDMV/a" } })], headers: {} };
			throw Object.assign(new Error("Forbidden"), { status: 403, response: { headers: { "retry-after": "30" } } });
		});
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv" });
		expect(out.truncated).toBe(true);
		expect(out.truncatedReason).toBe("rate-limited");
		expect(out.retryAfterSeconds).toBe(30);
		expect(out.alerts).toHaveLength(1);
	});

	it("omits retryAfterSeconds when GitHub sent none", async () => {
		const octokit = octokitWith(async () => { throw status(429, "Too Many Requests"); });
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv" });
		expect(out.truncatedReason).toBe("rate-limited");
		expect(out).not.toHaveProperty("retryAfterSeconds");
	});

	it("stops proactively at the rate-limit floor", async () => {
		const octokit = octokitWith(async () => ({ data: [dependabot(1)], headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "50" } }));
		const out = await reportSecurityAlerts(octokit, { owner: "cldmv" });
		expect(out.truncatedReason).toBe("rate-limited");
	});

	it("propagates an unexpected error from an org endpoint", async () => {
		const octokit = octokitWith(async () => { throw status(500, "server exploded"); });
		await expect(reportSecurityAlerts(octokit, { owner: "cldmv" })).rejects.toThrow("server exploded");
	});

	it("propagates an unexpected error from a per-repo endpoint", async () => {
		const octokit = octokitWith(async () => { throw status(500, "server exploded"); });
		await expect(reportSecurityAlerts(octokit, { owner: "cldmv", repo: "r" })).rejects.toThrow("server exploded");
	});

	it("clamps the caps to their hard maximums", async () => {
		const octokit = octokitWith(async () => ({ data: [], headers: {} }));
		await reportSecurityAlerts(octokit, { owner: "cldmv", repo: "r", types: ["codeql"], alertLimit: 99999, maxApiCalls: 99999, maxRepos: 99999 });
		expect(octokit.request).toHaveBeenCalledTimes(1);
	});

	it("advertises a valid schema", () => {
		expect(REPORT_SECURITY_ALERTS_SCHEMA.required).toEqual(["owner"]);
		expect(REPORT_SECURITY_ALERTS_SCHEMA.additionalProperties).toBe(false);
		expect(REPORT_SECURITY_ALERTS_SCHEMA.properties.types.items.enum).toEqual(["dependabot", "codeql", "secrets"]);
	});
});
