import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildCatalog } from "../src/catalog.ts";

function makeConfig(tools: any[], owners: Record<string, unknown> = { cldmv: { read: "cred:r", write: "cred:w" } }): any {
	return { listen: "unix:/x", upstream: "https://api.githubcopilot.com/mcp/", tools, owners };
}

describe("buildCatalog", () => {
	let secrets: { resolve: ReturnType<typeof vi.fn> };
	let upstream: { listToolsFor: ReturnType<typeof vi.fn> };
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		secrets = { resolve: vi.fn(() => "tok") };
		upstream = { listToolsFor: vi.fn() };
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.GH_BROKER_CATALOG_TIMEOUT_MS;
	});

	it("uses upstream schemas, emits local schemas for custom verbs, and skips unexposed proxied tools", async () => {
		const upstreamTool = { name: "get_me", description: "real", inputSchema: { type: "object", properties: {} } };
		upstream.listToolsFor.mockResolvedValue([upstreamTool]);
		const config = makeConfig([
			{ name: "get_me", mode: "read" },
			{ name: "not_exposed", mode: "read" },
			{ name: "link_issue", mode: "write", custom: true },
			{ name: "resolve_review_thread", mode: "write", custom: true },
			{ name: "reply_review_thread", mode: "write", custom: true },
			{ name: "mystery_custom", mode: "read", custom: true }
		]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);

		expect(secrets.resolve).toHaveBeenCalledWith("cred:r");
		const names = catalog.map((t) => t.name);
		// get_me is served from upstream; not_exposed is dropped (fetched but absent);
		// the two wired custom verbs get local schemas; link_issue is DEFERRED (its
		// catalog branch is commented out) and mystery_custom matches no branch — both
		// are silently skipped even when allowlisted.
		expect(names).toEqual(["get_me", "resolve_review_thread", "reply_review_thread"]);
		expect(names).not.toContain("link_issue");
		expect(catalog[0]).toBe(upstreamTool);
		expect(catalog.find((t) => t.name === "resolve_review_thread")?.inputSchema).toMatchObject({ type: "object" });
		expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/allowlisted tool "not_exposed" is NOT exposed/));
	});

	it("advertises report_unlabeled with its local schema", async () => {
		upstream.listToolsFor.mockResolvedValue([]);
		const config = makeConfig([{ name: "report_unlabeled", mode: "read", custom: true }]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(catalog).toHaveLength(1);
		expect(catalog[0]).toMatchObject({ name: "report_unlabeled" });
		expect(catalog[0]?.inputSchema).toMatchObject({ type: "object", required: ["owner"] });
	});

	it("advertises report_ci_status with its local schema", async () => {
		upstream.listToolsFor.mockResolvedValue([]);
		const config = makeConfig([{ name: "report_ci_status", mode: "read", custom: true }]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(catalog).toHaveLength(1);
		expect(catalog[0]).toMatchObject({ name: "report_ci_status" });
		expect(catalog[0]?.inputSchema).toMatchObject({ type: "object", required: ["owner", "repo"] });
	});

	it("falls back to minimal schemas when the upstream fetch fails", async () => {
		upstream.listToolsFor.mockRejectedValue(new Error("401 bad token"));
		const config = makeConfig([
			{ name: "get_me", mode: "read" },
			{ name: "resolve_review_thread", mode: "write", custom: true }
		]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);

		const getMe = catalog.find((t) => t.name === "get_me");
		expect(getMe).toEqual({ name: "get_me", description: "(read) proxied to the GitHub MCP", inputSchema: { type: "object" } });
		expect(catalog.map((t) => t.name)).toContain("resolve_review_thread");
		expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/could not fetch upstream tool schemas/));
	});

	it("skips the upstream fetch entirely when there are no owners", async () => {
		const config = makeConfig([{ name: "get_me", mode: "read" }], {});
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(upstream.listToolsFor).not.toHaveBeenCalled();
		expect(catalog).toEqual([{ name: "get_me", description: "(read) proxied to the GitHub MCP", inputSchema: { type: "object" } }]);
	});

	it("times out a slow upstream and advertises minimal schemas", async () => {
		process.env.GH_BROKER_CATALOG_TIMEOUT_MS = "15";
		upstream.listToolsFor.mockReturnValue(new Promise(() => {})); // never resolves
		const config = makeConfig([{ name: "get_me", mode: "read" }]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(catalog.map((t) => t.name)).toEqual(["get_me"]);
		expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/timed out after 15ms/));
	});
});
