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
		secrets = { resolve: vi.fn(() => "tok"), has: vi.fn(() => true) };
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

	it("advertises report_security_alerts with its local schema", async () => {
		upstream.listToolsFor.mockResolvedValue([]);
		const config = makeConfig([{ name: "report_security_alerts", mode: "read", custom: true }]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(catalog).toHaveLength(1);
		expect(catalog[0]).toMatchObject({ name: "report_security_alerts" });
		expect(catalog[0]?.inputSchema).toMatchObject({ type: "object", required: ["owner"] });
	});

	it("advertises report_release_prs with its local schema", async () => {
		upstream.listToolsFor.mockResolvedValue([]);
		const config = makeConfig([{ name: "report_release_prs", mode: "read", custom: true }]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(catalog).toHaveLength(1);
		expect(catalog[0]).toMatchObject({ name: "report_release_prs" });
		expect(catalog[0]?.inputSchema).toMatchObject({ type: "object", required: ["owner"] });
	});

	it("does not expose npm_scaffold without an npm block, or when its token is not stored", async () => {
		upstream.listToolsFor.mockResolvedValue([]);
		const rules = [{ name: "npm_scaffold", mode: "write", custom: true }];
		expect(await buildCatalog(makeConfig(rules), secrets as any, upstream as any)).toEqual([]);
		expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/"npm_scaffold" is not exposed: the npm integration is not configured/));
		secrets.has.mockReturnValue(false);
		const noToken = { ...makeConfig(rules), npm: { token: "cred:npm-token", scopes: ["@cldmv"] } };
		expect(await buildCatalog(noToken, secrets as any, upstream as any)).toEqual([]);
		expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/"npm_scaffold" is not exposed: its credential "npm-token" is not stored/));
	});

	it("advertises npm_scaffold with its local schema", async () => {
		upstream.listToolsFor.mockResolvedValue([]);
		const catalog = await buildCatalog({ ...makeConfig([{ name: "npm_scaffold", mode: "write", custom: true }]), npm: { token: "cred:npm-token", scopes: ["@cldmv"] } }, secrets as any, upstream as any);
		expect(catalog).toHaveLength(1);
		expect(catalog[0]).toMatchObject({ name: "npm_scaffold" });
		expect(catalog[0]?.description).toMatch(/one-time password/);
		expect(catalog[0]?.inputSchema).toMatchObject({ type: "object", required: ["owner", "repo", "package", "otp"] });
	});

	it("advertises issue_labels with its local schema", async () => {
		upstream.listToolsFor.mockResolvedValue([]);
		const config = makeConfig([{ name: "issue_labels", mode: "write", custom: true }]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(catalog).toHaveLength(1);
		expect(catalog[0]).toMatchObject({ name: "issue_labels" });
		expect(catalog[0]?.description).toMatch(/swap/);
		expect(catalog[0]?.inputSchema).toMatchObject({ type: "object", required: ["owner", "repo", "issue_number"] });
	});

	it("warns on issue_write that labels replaces the set, pointing at issue_labels when it is allowlisted", async () => {
		const upstreamTool = { name: "issue_write", description: "Create or update an issue.", inputSchema: { type: "object", properties: { labels: {} } } };
		upstream.listToolsFor.mockResolvedValue([upstreamTool]);
		const withVerb = await buildCatalog(
			makeConfig([{ name: "issue_write", mode: "write" }, { name: "issue_labels", mode: "write", custom: true }]),
			secrets as any,
			upstream as any
		);
		const iw = withVerb.find((t) => t.name === "issue_write")!;
		expect(iw.description).toMatch(/^Create or update an issue\. WARNING \(gh-broker\): "labels" REPLACES the issue's whole label set/);
		expect(iw.description).toMatch(/use issue_labels instead/);
		expect(iw.inputSchema).toBe(upstreamTool.inputSchema);
		expect(upstreamTool.description).toBe("Create or update an issue."); // the fetched tool is not mutated

		const without = await buildCatalog(makeConfig([{ name: "issue_write", mode: "write" }]), secrets as any, upstream as any);
		expect(without[0]?.description).toMatch(/REPLACES/);
		expect(without[0]?.description).not.toMatch(/issue_labels/);
		expect(without[0]?.description).toMatch(/pass the full set/);
	});

	it("still warns on issue_write when the upstream fetch fails (minimal schema)", async () => {
		upstream.listToolsFor.mockRejectedValue(new Error("down"));
		const catalog = await buildCatalog(makeConfig([{ name: "issue_write", mode: "write" }]), secrets as any, upstream as any);
		expect(catalog[0]?.description).toMatch(/^\(write\) proxied to the GitHub MCP WARNING/);
	});

	it("advertises report_ci_status with its local schema", async () => {
		upstream.listToolsFor.mockResolvedValue([]);
		const config = makeConfig([{ name: "report_ci_status", mode: "read", custom: true }]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(catalog).toHaveLength(1);
		expect(catalog[0]).toMatchObject({ name: "report_ci_status" });
		expect(catalog[0]?.inputSchema).toMatchObject({ type: "object", required: ["owner", "repo"] });
	});

	it("layers ciVerbosity/logLines onto pull_request_read's real upstream schema without dropping its own params", async () => {
		const upstreamTool = {
			name: "pull_request_read",
			description: "Get information on a specific pull request.",
			inputSchema: { type: "object", required: ["owner", "repo", "pullNumber", "method"], properties: { method: { type: "string" }, pullNumber: { type: "number" } } }
		};
		upstream.listToolsFor.mockResolvedValue([upstreamTool]);
		const config = makeConfig([{ name: "pull_request_read", mode: "read", augment: true }]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(catalog).toHaveLength(1);
		const tool = catalog[0]!;
		expect(tool.description).toContain("gh-broker extension");
		expect((tool.inputSchema as any).required).toEqual(["owner", "repo", "pullNumber", "method"]);
		expect((tool.inputSchema as any).properties.pullNumber).toEqual({ type: "number" });
		expect((tool.inputSchema as any).properties.ciVerbosity).toMatchObject({ type: "number", enum: [0, 1, 2, 3] });
		expect((tool.inputSchema as any).properties.logLines).toMatchObject({ type: "number" });
	});

	it("still adds ciVerbosity/logLines to pull_request_read when the upstream fetch fails entirely", async () => {
		upstream.listToolsFor.mockRejectedValue(new Error("network down"));
		const config = makeConfig([{ name: "pull_request_read", mode: "read", augment: true }]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(catalog).toHaveLength(1);
		expect((catalog[0]!.inputSchema as any).properties).toEqual({
			ciVerbosity: { type: "number", enum: [0, 1, 2, 3], description: expect.any(String) },
			logLines: { type: "number", description: expect.any(String) }
		});
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

	it("advertises ghcr_push / ghcr_push_status / ghcr_tags with their local schemas", async () => {
		upstream.listToolsFor.mockResolvedValue([]);
		const ghcrTools = [
			{ name: "ghcr_push", mode: "write", custom: true },
			{ name: "ghcr_push_status", mode: "read", custom: true },
			{ name: "ghcr_tags", mode: "read", custom: true }
		];
		const ghcr = { owners: { cldmv: { credential: "cred:cldmv-packages" }, other: { credential: "cred:other-packages" } } };
		const config = { ...makeConfig(ghcrTools), ghcr };
		// Exposed as soon as any one GHCR owner's credential is stored.
		secrets.has.mockImplementation((ref: string) => ref === "cred:other-packages");
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(catalog.map((t) => t.name)).toEqual(["ghcr_push", "ghcr_push_status", "ghcr_tags"]);
		expect(catalog[0]?.inputSchema).toMatchObject({ required: ["owner", "image", "tag", "archive"], additionalProperties: false });
		expect(catalog[0]?.description).toMatch(/background job/);
	});

	it("does not expose the GHCR tools without config.ghcr, or while no GHCR credential is stored", async () => {
		upstream.listToolsFor.mockResolvedValue([]);
		const rules = [{ name: "ghcr_push", mode: "write", custom: true }];
		expect(await buildCatalog(makeConfig(rules), secrets as any, upstream as any)).toEqual([]);
		expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/"ghcr_push" is not exposed: GHCR pushes are not configured/));
		secrets.has.mockReturnValue(false);
		const config = { ...makeConfig(rules), ghcr: { owners: { cldmv: { credential: "cred:cldmv-packages" } } } };
		expect(await buildCatalog(config, secrets as any, upstream as any)).toEqual([]);
		expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/no GHCR credential is stored \("cldmv-packages"; re-run the installer/));
	});
});
