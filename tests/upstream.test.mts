import { describe, it, expect, vi, beforeEach } from "vitest";

const { connectMock, callToolMock, listToolsMock } = vi.hoisted(() => ({
	connectMock: vi.fn(),
	callToolMock: vi.fn(),
	listToolsMock: vi.fn()
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	// Constructable mock (arrow fns can't be `new`-ed) — instances share the op mocks.
	Client: vi.fn(function (this: any) {
		this.connect = connectMock;
		this.callTool = callToolMock;
		this.listTools = listToolsMock;
	})
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: vi.fn(function () {})
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UpstreamPool } from "../src/upstream.ts";

const config: any = { listen: "unix:/x", upstream: "https://api.githubcopilot.com/mcp/", tools: [], owners: {} };

describe("UpstreamPool", () => {
	beforeEach(() => {
		connectMock.mockReset();
		callToolMock.mockReset();
		listToolsMock.mockReset();
		vi.mocked(Client).mockClear();
		vi.mocked(StreamableHTTPClientTransport).mockClear();
		connectMock.mockResolvedValue(undefined);
	});

	it("forward connects with a Bearer token and calls the tool", async () => {
		callToolMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const pool = new UpstreamPool(config);
		const out = await pool.forward("get_me", { a: 1 }, "TOK");

		expect(out).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(callToolMock).toHaveBeenCalledWith({ name: "get_me", arguments: { a: 1 } });
		expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(new URL(config.upstream), {
			requestInit: { headers: { Authorization: "Bearer TOK" } }
		});
	});

	it("listToolsFor returns the upstream tools array", async () => {
		listToolsMock.mockResolvedValue({ tools: [{ name: "get_me" }, { name: "list_issues" }] });
		const pool = new UpstreamPool(config);
		expect(await pool.listToolsFor("TOK")).toEqual([{ name: "get_me" }, { name: "list_issues" }]);
	});

	it("reuses a pooled client for the same token", async () => {
		callToolMock.mockResolvedValue({ content: [] });
		const pool = new UpstreamPool(config);
		await pool.forward("get_me", {}, "TOK");
		await pool.forward("list_issues", {}, "TOK");
		expect(vi.mocked(Client)).toHaveBeenCalledTimes(1); // connection created once, then reused
	});

	it("evicts the stale client and retries ONCE on a failed op", async () => {
		callToolMock.mockRejectedValueOnce(new Error("invalid session")).mockResolvedValueOnce({ content: [{ type: "text", text: "recovered" }] });
		const pool = new UpstreamPool(config);
		const out = await pool.forward("get_me", {}, "TOK");

		expect(out).toEqual({ content: [{ type: "text", text: "recovered" }] });
		expect(callToolMock).toHaveBeenCalledTimes(2);
		expect(vi.mocked(Client)).toHaveBeenCalledTimes(2); // reconnected with a fresh client
	});

	it("propagates after exactly one retry on a persistently-failing op", async () => {
		callToolMock.mockRejectedValue(new Error("bad token"));
		const pool = new UpstreamPool(config);
		await expect(pool.forward("get_me", {}, "TOK")).rejects.toThrow(/bad token/);
		expect(callToolMock).toHaveBeenCalledTimes(2); // initial + one retry, then throws
	});

	it("does not cache a failed connect", async () => {
		connectMock.mockRejectedValueOnce(new Error("connect fail"));
		callToolMock.mockResolvedValue({ content: [] });
		const pool = new UpstreamPool(config);

		await expect(pool.forward("get_me", {}, "TOK")).rejects.toThrow(/connect fail/);
		// connectMock now resolves (default) → a fresh connect is attempted, proving the
		// failed one was evicted rather than cached.
		await expect(pool.forward("get_me", {}, "TOK")).resolves.toEqual({ content: [] });
		expect(vi.mocked(Client)).toHaveBeenCalledTimes(2);
	});
});
