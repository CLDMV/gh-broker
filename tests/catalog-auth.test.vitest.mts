import { describe, it, expect, vi, afterEach } from "vitest";
import { buildCatalog } from "../src/catalog.ts";
import type { TokenResolver } from "../src/types.ts";

function makeConfig(tools: any[]): any {
	return { listen: "unix:/x", upstream: "https://api.githubcopilot.com/mcp/", tools, owners: { cldmv: { read: "cred:r", write: "cred:w" } } };
}

const UPSTREAM_TOOL = { name: "get_me", description: "real", inputSchema: { type: "object", properties: {} } };

describe("buildCatalog's library call shape (design #175 §2a/§2g)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.GH_BROKER_CATALOG_TIMEOUT_MS;
	});

	it("fetches upstream schemas with the resolver's token — the library's only credential path", async () => {
		const upstream = { listToolsFor: vi.fn().mockResolvedValue([UPSTREAM_TOOL]) };
		const resolveToken = vi.fn(async () => "resolved-token");
		const log = vi.fn();
		const catalog = await buildCatalog(makeConfig([{ name: "get_me", mode: "read" }]), resolveToken as unknown as TokenResolver, upstream as any, { log });
		expect(resolveToken).toHaveBeenCalledTimes(1);
		// No person of its own (schemas are owner-independent); the first configured owner's
		// read credential, asked for as a github read.
		expect(resolveToken).toHaveBeenCalledWith({ person: "", owner: "cldmv", mode: "read", kind: "github" });
		expect(upstream.listToolsFor).toHaveBeenCalledWith("resolved-token");
		expect(catalog).toEqual([UPSTREAM_TOOL]);
		expect(log).not.toHaveBeenCalled();
	});

	it("falls back to minimal schemas when the resolver returns null, and says so through opts.log", async () => {
		const upstream = { listToolsFor: vi.fn() };
		const log = vi.fn();
		const catalog = await buildCatalog(makeConfig([{ name: "get_me", mode: "read" }]), async () => null, upstream as any, { log });
		expect(upstream.listToolsFor).not.toHaveBeenCalled();
		expect(catalog).toEqual([{ name: "get_me", description: "(read) proxied to the GitHub MCP", inputSchema: { type: "object" } }]);
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/could not fetch upstream tool schemas \(the token resolver returned no token\)/));
	});

	it("honours opts.upstreamTimeoutMs", async () => {
		const upstream = { listToolsFor: vi.fn().mockReturnValue(new Promise(() => {})) }; // never resolves
		const log = vi.fn();
		const catalog = await buildCatalog(makeConfig([{ name: "get_me", mode: "read" }]), async () => "tok", upstream as any, { upstreamTimeoutMs: 15, log });
		expect(catalog).toEqual([{ name: "get_me", description: "(read) proxied to the GitHub MCP", inputSchema: { type: "object" } }]);
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/timed out after 15ms/));
	});

	it("reads no env and logs nothing when opts are absent (Quack-safe library default)", async () => {
		process.env.GH_BROKER_CATALOG_TIMEOUT_MS = "15";
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		// A fetch slower than the (ignored) env timeout still succeeds: absent opts mean a
		// plain 10000 ms default, never an env read.
		const upstream = { listToolsFor: vi.fn().mockImplementation(() => new Promise((r) => setTimeout(() => r([UPSTREAM_TOOL]), 40))) };
		const catalog = await buildCatalog(makeConfig([{ name: "get_me", mode: "read" }]), async () => "tok", upstream as any);
		expect(catalog).toEqual([UPSTREAM_TOOL]);
		expect(errSpy).not.toHaveBeenCalled();
	});

	it("applies the caller's capability predicate, skipping and logging refusals through opts.log", async () => {
		const upstream = { listToolsFor: vi.fn().mockResolvedValue([UPSTREAM_TOOL]) };
		const log = vi.fn();
		const catalog = await buildCatalog(
			makeConfig([
				{ name: "get_me", mode: "read" },
				{ name: "npm_scaffold", mode: "write", custom: true }
			]),
			async () => "tok",
			upstream as any,
			{ log, unavailable: (rule) => (rule.name === "npm_scaffold" ? "the npm integration is not configured (enable it with the installer's --npm)" : undefined) }
		);
		expect(catalog.map((t) => t.name)).toEqual(["get_me"]);
		expect(log).toHaveBeenCalledWith('catalog: "npm_scaffold" is not exposed: the npm integration is not configured (enable it with the installer\'s --npm)');
	});
});
