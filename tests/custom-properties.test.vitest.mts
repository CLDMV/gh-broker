import { describe, it, expect, vi } from "vitest";
import { reportCustomProperties, filterProperties, REPORT_CUSTOM_PROPERTIES_SCHEMA } from "../src/core/verbs/report_custom_properties.ts";

type Handler = (route: string, params: any) => Promise<{ data: unknown; headers?: Record<string, string> }>;
const octokitWith = (handler: Handler): any => ({ request: vi.fn(handler) });
const status = (code: number, message = "x", headers: Record<string, string> = {}) =>
	Object.assign(new Error(message), { status: code, response: { headers } });
const ok = (data: unknown) => ({ data, headers: {} });

const entry = (name: string, props: Record<string, string | string[] | null>) => ({
	repository_id: 1,
	repository_name: name,
	repository_full_name: `CLDMV/${name}`,
	properties: Object.entries(props).map(([property_name, value]) => ({ property_name, value }))
});

describe("filterProperties", () => {
	const props = { "branch-model": "v4", teams: ["core", "infra"], empty: null };
	it("passes everything through without a property", () => {
		expect(filterProperties(props)).toBe(props);
	});
	it("keeps only the named property, and drops repos where it is unset or null", () => {
		expect(filterProperties(props, "branch-model")).toEqual({ "branch-model": "v4" });
		expect(filterProperties(props, "missing")).toBeUndefined();
		expect(filterProperties(props, "empty")).toBeUndefined();
	});
	it("matches a value, or one of a multi-select's values", () => {
		expect(filterProperties(props, "branch-model", "v4")).toEqual({ "branch-model": "v4" });
		expect(filterProperties(props, "branch-model", "v3")).toBeUndefined();
		expect(filterProperties(props, "teams", "infra")).toEqual({ teams: ["core", "infra"] });
		expect(filterProperties(props, "teams", "web")).toBeUndefined();
	});
});

describe("reportCustomProperties — one repo", () => {
	it("reads the repo's values", async () => {
		const octokit = octokitWith(async (route, p) => {
			expect(route).toBe("GET /repos/{owner}/{repo}/properties/values");
			expect(p).toMatchObject({ owner: "CLDMV", repo: "nexus" });
			return ok([
				{ property_name: "branch-model", value: "v4" },
				{ property_name: "tier", value: null }
			]);
		});
		const out = await reportCustomProperties(octokit, { owner: "CLDMV", repo: "nexus" });
		expect(out).toEqual({
			owner: "CLDMV",
			repo: "nexus",
			repos: [{ repo: "nexus", properties: { "branch-model": "v4", tier: null } }],
			count: 1
		});
	});

	it("returns no repos when the filter doesn't match", async () => {
		const octokit = octokitWith(async () => ok([{ property_name: "branch-model", value: "dev-trunk" }]));
		const out = await reportCustomProperties(octokit, { owner: "CLDMV", repo: "nexus", property: "branch-model", value: "v4" });
		expect(out).toEqual({ owner: "CLDMV", repo: "nexus", repos: [], count: 0 });
	});

	it("names the missing repository permission on a 403, and passes other errors through", async () => {
		await expect(
			reportCustomProperties(
				octokitWith(async () => {
					throw status(403, "Resource not accessible by personal access token");
				}),
				{ owner: "CLDMV", repo: "nexus" }
			)
		).rejects.toThrow('repository permission "Custom properties: read"');
		await expect(
			reportCustomProperties(
				octokitWith(async () => {
					throw status(404, "Not Found");
				}),
				{ owner: "CLDMV", repo: "nope" }
			)
		).rejects.toThrow("Not Found");
	});

	it("reports a rate limit as truncated, with retryAfterSeconds when GitHub sent it", async () => {
		const a = await reportCustomProperties(
			octokitWith(async () => {
				throw status(429, "Too Many Requests", { "retry-after": "12" });
			}),
			{ owner: "CLDMV", repo: "nexus" }
		);
		expect(a).toEqual({
			owner: "CLDMV",
			repo: "nexus",
			repos: [],
			count: 0,
			truncated: true,
			truncatedReason: "rate-limited",
			retryAfterSeconds: 12
		});
		const b = await reportCustomProperties(
			octokitWith(async () => {
				throw status(429, "Too Many Requests");
			}),
			{ owner: "CLDMV", repo: "nexus" }
		);
		expect(b).not.toHaveProperty("retryAfterSeconds");
		const c = await reportCustomProperties(
			octokitWith(async () => ok([])),
			{ owner: "CLDMV", repo: "nexus", maxApiCalls: 0 }
		);
		expect(c).toEqual({ owner: "CLDMV", repo: "nexus", repos: [], count: 0, truncated: true, truncatedReason: "max-api-calls" });
	});

	it("refuses value without property, and repositoryQuery with repo", async () => {
		const octokit = octokitWith(async () => ok([]));
		await expect(reportCustomProperties(octokit, { owner: "CLDMV", value: "v4" })).rejects.toThrow("value needs property");
		await expect(reportCustomProperties(octokit, { owner: "CLDMV", repo: "nexus", repositoryQuery: "archived:false" })).rejects.toThrow(
			"org listing only"
		);
		expect(octokit.request).not.toHaveBeenCalled();
	});
});

describe("reportCustomProperties — org listing", () => {
	const page = (n: number, offset = 0) =>
		Array.from({ length: n }, (_, i) => entry(`r${offset + i}`, { "branch-model": (offset + i) % 2 ? "v4" : "dev-trunk" }));

	it("pages through the org listing, passes repository_query, and filters", async () => {
		const octokit = octokitWith(async (route, p) => {
			expect(route).toBe("GET /orgs/{org}/properties/values");
			expect(p).toMatchObject({ org: "CLDMV", repository_query: "archived:false", per_page: 100 });
			return ok(p.page === 1 ? page(100) : page(5, 100));
		});
		const out = await reportCustomProperties(octokit, {
			owner: "CLDMV",
			property: "branch-model",
			value: "v4",
			repositoryQuery: "archived:false"
		});
		expect(octokit.request).toHaveBeenCalledTimes(2);
		expect(out.count).toBe(52);
		expect(out.repos[0]).toEqual({ repo: "r1", properties: { "branch-model": "v4" } });
		expect(out).not.toHaveProperty("truncated");
	});

	it("leaves repository_query out when none is given, and tolerates an entry without properties", async () => {
		const octokit = octokitWith(async (_route, p) => {
			expect(p).not.toHaveProperty("repository_query");
			return ok([{ repository_name: "bare" }, entry("x", { a: "1" })]);
		});
		const out = await reportCustomProperties(octokit, { owner: "CLDMV" });
		expect(out.repos).toEqual([
			{ repo: "bare", properties: {} },
			{ repo: "x", properties: { a: "1" } }
		]);
	});

	it("stops at maxRepos and says so; exactly maxRepos is not truncation", async () => {
		const octokit = octokitWith(async () => ok(page(3)));
		const cut = await reportCustomProperties(octokit, { owner: "CLDMV", maxRepos: 2 });
		expect(cut).toMatchObject({ count: 2, truncated: true, truncatedReason: "max-repos" });
		const exact = await reportCustomProperties(octokit, { owner: "CLDMV", maxRepos: 3 });
		expect(exact.count).toBe(3);
		expect(exact).not.toHaveProperty("truncated");
	});

	it("truncates on the call budget and on a rate limit", async () => {
		const budget = await reportCustomProperties(
			octokitWith(async () => ok(page(100))),
			{ owner: "CLDMV", maxApiCalls: 2 }
		);
		expect(budget).toMatchObject({ truncated: true, truncatedReason: "max-api-calls", repos: [], count: 0 });
		const limited = await reportCustomProperties(
			octokitWith(async () => {
				throw status(429, "Too Many Requests", { "retry-after": "5" });
			}),
			{ owner: "CLDMV" }
		);
		expect(limited).toMatchObject({ truncated: true, truncatedReason: "rate-limited", retryAfterSeconds: 5 });
		const noRetry = await reportCustomProperties(
			octokitWith(async () => {
				throw status(429, "Too Many Requests");
			}),
			{ owner: "CLDMV" }
		);
		expect(noRetry).not.toHaveProperty("retryAfterSeconds");
	});

	it("explains a 404 (not an org), names the org permission on a 403, and passes other errors through", async () => {
		await expect(
			reportCustomProperties(
				octokitWith(async () => {
					throw status(404, "Not Found");
				}),
				{ owner: "someuser" }
			)
		).rejects.toThrow("custom properties are org-only");
		await expect(
			reportCustomProperties(
				octokitWith(async () => {
					throw status(403, "Resource not accessible");
				}),
				{ owner: "CLDMV" }
			)
		).rejects.toThrow('organization permission "Custom properties: read"');
		await expect(
			reportCustomProperties(
				octokitWith(async () => {
					throw status(500, "boom");
				}),
				{ owner: "CLDMV" }
			)
		).rejects.toThrow("boom");
	});

	it("clamps maxRepos and maxApiCalls to their hard caps", async () => {
		const octokit = octokitWith(async () => ok(page(1)));
		const out = await reportCustomProperties(octokit, { owner: "CLDMV", maxRepos: 999999, maxApiCalls: 999999 });
		expect(out.count).toBe(1);
	});
});

describe("REPORT_CUSTOM_PROPERTIES_SCHEMA", () => {
	it("requires owner and allows no extra properties", () => {
		expect(REPORT_CUSTOM_PROPERTIES_SCHEMA.required).toEqual(["owner"]);
		expect(REPORT_CUSTOM_PROPERTIES_SCHEMA.additionalProperties).toBe(false);
		expect(Object.keys(REPORT_CUSTOM_PROPERTIES_SCHEMA.properties).sort()).toEqual([
			"maxApiCalls",
			"maxRepos",
			"owner",
			"property",
			"repo",
			"repositoryQuery",
			"value"
		]);
	});
});
