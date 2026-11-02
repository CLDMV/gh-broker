import { describe, it, expect, vi } from "vitest";
import { CallBudget, CallBudgetExhausted, RateLimited, listOwnerRepos, paginateAfter, req, reqOne } from "../src/verbs/rest-client.ts";

function octokitWith(handler: (route: string, params: any) => Promise<{ data: unknown; headers?: Record<string, string> }>): any {
	return { request: vi.fn(handler) };
}

describe("403 classification", () => {
	const call = (err: unknown) => req(octokitWith(async () => { throw err; }), new CallBudget(5), "GET /x", {});

	it("treats a 403 with Retry-After as a rate limit and carries the delay", async () => {
		const err = Object.assign(new Error("Forbidden"), { status: 403, response: { headers: { "retry-after": "42" } } });
		await expect(call(err)).rejects.toMatchObject({ retryAfterSeconds: 42 });
		await expect(call(err)).rejects.toBeInstanceOf(RateLimited);
	});

	it("treats a 403 with an exhausted x-ratelimit-remaining as a rate limit", async () => {
		const err = Object.assign(new Error("Forbidden"), { status: 403, response: { headers: { "x-ratelimit-remaining": "0" } } });
		await expect(call(err)).rejects.toBeInstanceOf(RateLimited);
	});

	it("treats a 403 whose message mentions a rate limit or abuse detection as a rate limit", async () => {
		await expect(call(Object.assign(new Error("API rate limit exceeded"), { status: 403 }))).rejects.toBeInstanceOf(RateLimited);
		await expect(call(Object.assign(new Error("You have exceeded a secondary rate limit"), { status: 403 }))).rejects.toBeInstanceOf(RateLimited);
		await expect(call(Object.assign(new Error("abuse detection mechanism"), { status: 403 }))).rejects.toBeInstanceOf(RateLimited);
	});

	it("always treats a 429 as a rate limit", async () => {
		await expect(call(Object.assign(new Error("Too Many Requests"), { status: 429 }))).rejects.toBeInstanceOf(RateLimited);
	});

	it("rethrows a plain permission 403 with its status intact instead of calling it a rate limit", async () => {
		const err = Object.assign(new Error("Code Security must be enabled for this repository to use code scanning."), { status: 403 });
		const rejected = await call(err).catch((e) => e);
		expect(rejected).not.toBeInstanceOf(RateLimited);
		expect(rejected).toBe(err);
		expect(rejected.status).toBe(403);
	});

	it("still rethrows other statuses untouched", async () => {
		const err = Object.assign(new Error("Not Found"), { status: 404 });
		await expect(call(err)).rejects.toBe(err);
	});
});

describe("paginateAfter (Link-header cursor pagination)", () => {
	const link = (cursor: string) => `<https://api.github.com/x?per_page=100&after=${cursor}>; rel="next", <https://api.github.com/x?per_page=100>; rel="first"`;

	it("follows the rel=next cursor across pages and stops when there is no next link", async () => {
		const octokit = octokitWith(async (_route, params) => {
			if (!params.after) return { data: [{ n: 1 }, { n: 2 }], headers: { link: link("CUR1") } };
			if (params.after === "CUR1") return { data: [{ n: 3 }], headers: {} };
			throw new Error(`unexpected cursor ${params.after}`);
		});
		const out = await paginateAfter<{ n: number }>(octokit, new CallBudget(10), "GET /x", { a: 1 }, 100);
		expect(out.map((o) => o.n)).toEqual([1, 2, 3]);
		expect(octokit.request).toHaveBeenCalledTimes(2);
		expect(octokit.request.mock.calls[0]![1]).toMatchObject({ a: 1, per_page: 100 });
		expect(octokit.request.mock.calls[0]![1]).not.toHaveProperty("after");
	});

	it("URL-decodes the cursor before sending it back", async () => {
		const octokit = octokitWith(async (_route, params) => {
			if (!params.after) return { data: [{ n: 1 }], headers: { link: link("a%3Db%2Fc") } };
			expect(params.after).toBe("a=b/c");
			return { data: [], headers: {} };
		});
		await paginateAfter(octokit, new CallBudget(10), "GET /x", {}, 100);
		expect(octokit.request).toHaveBeenCalledTimes(2);
	});

	it("stops at the limit even when more pages exist, trimming to the limit", async () => {
		const octokit = octokitWith(async () => ({ data: [{ n: 1 }, { n: 2 }, { n: 3 }], headers: { link: link("MORE") } }));
		const out = await paginateAfter(octokit, new CallBudget(10), "GET /x", {}, 2);
		expect(out).toHaveLength(2);
		expect(octokit.request).toHaveBeenCalledTimes(1);
	});

	it("stops on an empty page and on a non-array body", async () => {
		expect(await paginateAfter(octokitWith(async () => ({ data: [], headers: { link: link("X") } })), new CallBudget(5), "GET /x", {}, 10)).toEqual([]);
		expect(await paginateAfter(octokitWith(async () => ({ data: { message: "nope" }, headers: {} })), new CallBudget(5), "GET /x", {}, 10)).toEqual([]);
	});

	it("charges the call budget per page and throws once it is spent", async () => {
		const octokit = octokitWith(async () => ({ data: [{ n: 1 }], headers: { link: link("MORE") } }));
		await expect(paginateAfter(octokit, new CallBudget(2), "GET /x", {}, 100)).rejects.toBeInstanceOf(CallBudgetExhausted);
	});
});

describe("listOwnerRepos", () => {
	it("returns non-archived repo names from the org endpoint", async () => {
		const octokit = octokitWith(async () => ({ data: [{ name: "a" }, { name: "b", archived: true }, { name: "c" }], headers: {} }));
		expect(await listOwnerRepos(octokit, new CallBudget(5), "cldmv", 50)).toEqual(["a", "c"]);
	});

	it("falls back to the user endpoint when the org endpoint 404s", async () => {
		const octokit = octokitWith(async (route) => {
			if (route === "GET /orgs/{owner}/repos") throw Object.assign(new Error("Not Found"), { status: 404 });
			return { data: [{ name: "solo" }], headers: {} };
		});
		expect(await listOwnerRepos(octokit, new CallBudget(5), "someone", 50)).toEqual(["solo"]);
	});

	it("does not fall back on a rate limit or budget exhaustion", async () => {
		const limited = octokitWith(async () => { throw Object.assign(new Error("x"), { status: 429 }); });
		await expect(listOwnerRepos(limited, new CallBudget(5), "cldmv", 50)).rejects.toBeInstanceOf(RateLimited);
		expect(limited.request).toHaveBeenCalledTimes(1);
		await expect(listOwnerRepos(octokitWith(async () => ({ data: [], headers: {} })), new CallBudget(0), "cldmv", 50)).rejects.toBeInstanceOf(CallBudgetExhausted);
	});

	it("propagates a non-404 error", async () => {
		const octokit = octokitWith(async () => { throw Object.assign(new Error("boom"), { status: 500 }); });
		await expect(listOwnerRepos(octokit, new CallBudget(5), "cldmv", 50)).rejects.toThrow("boom");
	});
});

describe("rate-limit floor", () => {
	const lowQuota = { "x-ratelimit-remaining": "9", "x-ratelimit-limit": "10" };

	it("stops proactively once remaining drops under the floor", async () => {
		const o = octokitWith(async () => ({ data: {}, headers: lowQuota }));
		await expect(reqOne(o, new CallBudget(5), "GET /x", {})).rejects.toBeInstanceOf(RateLimited);
	});

	it("ignoreRateFloor skips the proactive stop for small-quota endpoints like code search", async () => {
		const o = octokitWith(async () => ({ data: { ok: true }, headers: lowQuota }));
		await expect(reqOne(o, new CallBudget(5), "GET /x", {}, { ignoreRateFloor: true })).resolves.toEqual({ ok: true });
	});

	it("ignoreRateFloor still raises RateLimited on a real 429", async () => {
		const o = octokitWith(async () => {
			throw Object.assign(new Error("Too Many Requests"), { status: 429 });
		});
		await expect(reqOne(o, new CallBudget(5), "GET /x", {}, { ignoreRateFloor: true })).rejects.toBeInstanceOf(RateLimited);
	});
});
