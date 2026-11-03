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

	it("advertises report_dependents with its local schema", async () => {
		upstream.listToolsFor.mockResolvedValue([]);
		const config = makeConfig([{ name: "report_dependents", mode: "read", custom: true }]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(catalog).toHaveLength(1);
		expect(catalog[0]).toMatchObject({ name: "report_dependents" });
		expect(catalog[0]?.inputSchema).toMatchObject({ type: "object", required: ["owner", "name"] });
	});

	it("advertises report_release_prs with its local schema", async () => {
		upstream.listToolsFor.mockResolvedValue([]);
		const config = makeConfig([{ name: "report_release_prs", mode: "read", custom: true }]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(catalog).toHaveLength(1);
		expect(catalog[0]).toMatchObject({ name: "report_release_prs" });
		expect(catalog[0]?.inputSchema).toMatchObject({ type: "object", required: ["owner"] });
	});

	it("advertises report_release_changes with its local schema", async () => {
		upstream.listToolsFor.mockResolvedValue([]);
		const config = makeConfig([{ name: "report_release_changes", mode: "read", custom: true }]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(catalog).toHaveLength(1);
		expect(catalog[0]).toMatchObject({ name: "report_release_changes" });
		expect(catalog[0]?.inputSchema).toMatchObject({ type: "object", required: ["owner", "repo", "pull"] });
	});
	it("advertises report_alert_status with its local schema", async () => {
		upstream.listToolsFor.mockResolvedValue([]);
		const config = makeConfig([{ name: "report_alert_status", mode: "read", custom: true }]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(catalog).toHaveLength(1);
		expect(catalog[0]).toMatchObject({ name: "report_alert_status" });
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
		expect(catalog[0]?.inputSchema).toMatchObject({ type: "object", required: ["owner", "repo", "package", "npm_otp"] });
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

	it("warns on issue_write even when the upstream tool carries no description", async () => {
		upstream.listToolsFor.mockResolvedValue([{ name: "issue_write", inputSchema: { type: "object" } }]);
		const catalog = await buildCatalog(makeConfig([{ name: "issue_write", mode: "write" }]), secrets as any, upstream as any);
		expect(catalog[0]?.description).toMatch(/^WARNING \(gh-broker\): "labels" REPLACES/);
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

	it("layers ciVerbosity/logLines/maxDetail onto list_pull_requests's real upstream schema", async () => {
		const upstreamTool = {
			name: "list_pull_requests",
			description: "List pull requests.",
			inputSchema: { type: "object", required: ["owner", "repo"], properties: { state: { type: "string" } } }
		};
		upstream.listToolsFor.mockResolvedValue([upstreamTool]);
		const config = makeConfig([{ name: "list_pull_requests", mode: "read", augment: true }]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		const tool = catalog[0]!;
		expect(tool.description).toContain("List pull requests.");
		expect(tool.description).toContain("maxDetail");
		expect((tool.inputSchema as any).required).toEqual(["owner", "repo"]);
		expect((tool.inputSchema as any).properties.state).toEqual({ type: "string" });
		expect((tool.inputSchema as any).properties.ciVerbosity).toMatchObject({ type: "number", enum: [0, 1, 2, 3] });
		expect((tool.inputSchema as any).properties.logLines).toMatchObject({ type: "number" });
		expect((tool.inputSchema as any).properties.maxDetail).toMatchObject({ type: "number" });
	});

	it("still adds the extension params to list_pull_requests when the upstream fetch fails entirely", async () => {
		upstream.listToolsFor.mockRejectedValue(new Error("network down"));
		const config = makeConfig([{ name: "list_pull_requests", mode: "read", augment: true }]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(Object.keys((catalog[0]!.inputSchema as any).properties)).toEqual(["ciVerbosity", "logLines", "maxDetail"]);
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

	it("advertises the #146 custom verbs with their local schemas", async () => {
		upstream.listToolsFor.mockResolvedValue([]);
		const config = makeConfig([
			{ name: "minimize_comment", mode: "write", custom: true },
			{ name: "delete_branch", mode: "write", custom: true, otp: false },
			{ name: "dismiss_alert", mode: "write", custom: true, otp: false }
		]);
		const catalog = await buildCatalog(config, secrets as any, upstream as any);
		expect(catalog.map((t) => [t.name, (t.inputSchema as any).required])).toEqual([
			["minimize_comment", ["owner"]],
			["delete_branch", ["owner", "repo", "branch"]],
			["dismiss_alert", ["owner", "repo", "kind", "alertNumber"]]
		]);
		expect(catalog[0]!.description).toMatch(/^Hide a comment/);
		expect(catalog[1]!.description).toMatch(/^Delete one branch/);
		expect(catalog[2]!.description).toMatch(/^Dismiss one code scanning/);
	});

	it("marks organization (and private, for create_repository) required on the repo-creating tools", async () => {
		const createSchema = { type: "object", properties: { name: {}, organization: {}, private: {} }, required: ["name"] };
		upstream.listToolsFor.mockResolvedValue([
			{ name: "create_repository", description: "Create a repo.", inputSchema: createSchema },
			{ name: "fork_repository", inputSchema: { type: "object", properties: {} } }
		]);
		const config = makeConfig([
			{ name: "create_repository", mode: "write", otp: false },
			{ name: "fork_repository", mode: "write", otp: false }
		]);
		const [create, fork] = await buildCatalog(config, secrets as any, upstream as any);
		expect((create!.inputSchema as any).required).toEqual(["name", "organization", "private"]);
		expect(create!.description).toBe('Create a repo. gh-broker: "organization" and "private" are required; the repo is never created in a personal account or left public by default.');
		expect((fork!.inputSchema as any).required).toEqual(["organization"]);
		expect(fork!.description).toMatch(/^gh-broker: "organization" \(where the fork goes\) is required/);
		expect(createSchema.required).toEqual(["name"]);
	});

	it("says on actions_run_trigger that log deletion is refused", async () => {
		upstream.listToolsFor.mockResolvedValue([{ name: "actions_run_trigger", description: "Trigger.", inputSchema: { type: "object" } }]);
		const [tool] = await buildCatalog(makeConfig([{ name: "actions_run_trigger", mode: "write", otp: false }]), secrets as any, upstream as any);
		expect(tool!.description).toBe('Trigger. gh-broker: method "delete_workflow_run_logs" is refused; a run\'s logs are kept.');
		upstream.listToolsFor.mockResolvedValue([{ name: "actions_run_trigger", inputSchema: { type: "object" } }]);
		const [bare] = await buildCatalog(makeConfig([{ name: "actions_run_trigger", mode: "write", otp: false }]), secrets as any, upstream as any);
		expect(bare!.description).toMatch(/^gh-broker: method "delete_workflow_run_logs"/);
	});

	it("hides default-gated tools while OTP isn't set up", async () => {
		upstream.listToolsFor.mockResolvedValue([{ name: "merge_pull_request", inputSchema: { type: "object" } }]);
		const catalog = await buildCatalog(makeConfig([{ name: "merge_pull_request", mode: "write" }, { name: "delete_branch", mode: "write", custom: true }]), secrets as any, upstream as any);
		expect(catalog).toEqual([]);
		expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/"merge_pull_request" is not exposed: OTP is not set up/));
	});

	describe("OTP gate", () => {
		const seedSecrets = () => ({ resolve: vi.fn((ref: string) => (ref === "cred:otp-seed" ? "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" : "tok")), has: vi.fn(() => true) });
		const otpConfig = (rules: any[], otp: Record<string, unknown> = {}) => ({ ...makeConfig(rules), otp: { seed: "cred:otp-seed", ...otp } });

		it("adds a required otp argument and a description sentence to gated tools, copying schemas", async () => {
			const upstreamSchema = { type: "object", properties: { owner: { type: "string" } }, required: ["owner"] };
			const upstreamTool = { name: "merge_pull_request", description: "Merge a PR.", inputSchema: upstreamSchema };
			upstream.listToolsFor.mockResolvedValue([upstreamTool, { name: "get_me", description: "me", inputSchema: { type: "object" } }]);
			const before = JSON.stringify(upstreamTool);
			const catalog = await buildCatalog(
				otpConfig([{ name: "merge_pull_request", mode: "write", otp: true }, { name: "get_me", mode: "read" }, { name: "otp_status", mode: "read", custom: true }]) as any,
				seedSecrets() as any,
				upstream as any
			);
			const merge = catalog.find((t) => t.name === "merge_pull_request")!;
			expect(merge.inputSchema).toEqual({ type: "object", properties: { owner: { type: "string" }, otp: { type: "string", description: expect.any(String) } }, required: ["owner", "otp"] });
			expect(merge.description).toBe(
				'Merge a PR. Needs a broker OTP (gh-broker): ask the user for a current code from their authenticator app and pass it as "otp". One code works for every gated tool for 5 minutes after the first call that uses it.'
			);
			expect(JSON.stringify(upstreamTool)).toBe(before);
			// Ungated tools are passed through untouched.
			expect(catalog.find((t) => t.name === "get_me")).toBe((await upstream.listToolsFor.mock.results[0]!.value)[1]);
			expect(catalog.find((t) => t.name === "otp_status")).toMatchObject({ name: "otp_status", inputSchema: { type: "object", properties: {} } });
			expect(catalog.find((t) => t.name === "otp_status")!.description).toMatch(/Never shows a code or the seed/);
		});

		it("gates a custom verb without mutating its shared schema constant, and uses the configured window", async () => {
			upstream.listToolsFor.mockResolvedValue([]);
			const { NPM_SCAFFOLD_SCHEMA } = await import("../src/verbs/npm_scaffold.ts");
			const before = JSON.stringify(NPM_SCAFFOLD_SCHEMA);
			const cfg = { ...otpConfig([{ name: "npm_scaffold", mode: "write", custom: true, otp: true }], { windowSeconds: 90 }), npm: { token: "cred:npm-token", scopes: ["@cldmv"] } };
			const [tool] = await buildCatalog(cfg as any, seedSecrets() as any, upstream as any);
			expect(tool!.inputSchema).toMatchObject({ required: ["owner", "repo", "package", "npm_otp", "otp"], properties: { npm_otp: expect.any(Object), otp: expect.any(Object) } });
			expect(tool!.description).toMatch(/for 90 seconds after the first call/);
			expect(JSON.stringify(NPM_SCAFFOLD_SCHEMA)).toBe(before);
		});

		it("fills in a minimal schema and never lists otp twice", async () => {
			upstream.listToolsFor.mockRejectedValue(new Error("offline"));
			const [minimal] = await buildCatalog(otpConfig([{ name: "merge_pull_request", mode: "write", otp: true }]) as any, seedSecrets() as any, upstream as any);
			expect(minimal!.inputSchema).toEqual({ type: "object", properties: { otp: expect.any(Object) }, required: ["otp"] });

			upstream.listToolsFor.mockResolvedValue([{ name: "merge_pull_request", inputSchema: { type: "object", required: ["otp"] } }]);
			const [already] = await buildCatalog(otpConfig([{ name: "merge_pull_request", mode: "write", otp: true }]) as any, seedSecrets() as any, upstream as any);
			expect((already!.inputSchema as any).required).toEqual(["otp"]);
			expect(already!.description).toMatch(/^Needs a broker OTP/);
		});

		it("hides gated tools while OTP isn't set up, saying why", async () => {
			upstream.listToolsFor.mockResolvedValue([{ name: "merge_pull_request", inputSchema: { type: "object" } }]);
			const rules = [{ name: "merge_pull_request", mode: "write", otp: true }, { name: "otp_status", mode: "read", custom: true }];
			expect((await buildCatalog(makeConfig(rules), secrets as any, upstream as any)).map((t) => t.name)).toEqual(["otp_status"]);
			expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/"merge_pull_request" is not exposed: OTP is not set up on this broker/));
			const noSeed = { resolve: vi.fn(() => "tok"), has: vi.fn((ref: string) => ref !== "cred:otp-seed") };
			expect((await buildCatalog(otpConfig(rules) as any, noSeed as any, upstream as any)).map((t) => t.name)).toEqual(["otp_status"]);
		});
	});
});
