import { describe, it, expect, vi, afterEach } from "vitest";
import { connect, type Socket } from "node:net";
import { mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { startServer } from "../src/server.ts";

// Real node:fs, except readFileSync is a spy so the /etc/group lookup can be forced to fail.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

// Real node:net, except createServer remembers the server-side sockets so a test can inject events on them.
const seen = vi.hoisted(() => ({ sockets: [] as any[] }));
vi.mock("node:net", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:net")>();
	return {
		...actual,
		createServer: (listener: (s: any) => void) =>
			actual.createServer((s) => {
				seen.sockets.push(s);
				listener(s);
			})
	};
});

const root = join(process.cwd(), "tmp", "tests", "server");
const fakeRouter: any = { call: vi.fn(async (name: string, args: unknown) => ({ content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }] })) };
const catalog: any[] = [{ name: "get_me", description: "me", inputSchema: { type: "object" } }];
const sockets: Socket[] = [];

function sockPath(name: string): string {
	mkdirSync(root, { recursive: true });
	rmSync(join(root, name), { force: true }); // a socket left behind by an earlier run
	return join(root, name);
}

/** Open a client connection and return a request/response helper over newline-delimited JSON-RPC. */
async function client(path: string) {
	const sock: Socket = await new Promise((resolve, reject) => {
		const s = connect(path, () => resolve(s));
		s.once("error", reject);
	});
	sockets.push(sock);
	let buf = "";
	const waiting = new Map<number, (m: any) => void>();
	sock.on("data", (d) => {
		buf += d.toString("utf8");
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const msg = JSON.parse(buf.slice(0, nl));
			buf = buf.slice(nl + 1);
			waiting.get(msg.id)?.(msg);
		}
	});
	let id = 0;
	return {
		sock,
		request: (method: string, params: unknown) =>
			new Promise<any>((resolve) => {
				const i = ++id;
				waiting.set(i, resolve);
				sock.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
			})
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const s of sockets.splice(0)) s.destroy();
	delete process.env.GH_BROKER_SOCKET_GROUP;
	vi.mocked(readFileSync).mockClear();
});

describe("startServer", () => {
	it("throws synchronously for a non-unix listen scheme", () => {
		expect(() => startServer({ listen: "tcp:0.0.0.0:9000" } as any, fakeRouter, catalog)).toThrow(/unsupported listen/);
	});

	it("rejects when the socket cannot be bound", async () => {
		const config: any = { listen: "unix:/no/such/dir/gh-broker.sock" };
		await expect(startServer(config, fakeRouter, catalog)).rejects.toBeTruthy();
	});

	it("serves tools/list and tools/call over the socket, then drops the connection cleanly", async () => {
		const path = sockPath("serve.sock");
		await startServer({ listen: `unix:${path}` } as any, fakeRouter, catalog);
		expect(statSync(path).mode & 0o777).toBe(0o660);

		const c = await client(path);
		const init = await c.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
		expect(init.result.serverInfo.name).toBe("gh-broker");
		const listed = await c.request("tools/list", {});
		expect(listed.result.tools).toEqual(catalog);
		const called = await c.request("tools/call", { name: "get_me", arguments: { a: 1 } });
		expect(called.result.content[0].text).toBe('get_me:{"a":1}');
		// arguments omitted → router receives {}
		const noArgs = await c.request("tools/call", { name: "get_me" });
		expect(noArgs.result.content[0].text).toBe("get_me:{}");

		c.sock.destroy();
		await new Promise((r) => setTimeout(r, 50));
	});

	it("replaces a stale socket file left by a previous run", async () => {
		const path = sockPath("stale.sock");
		writeFileSync(path, "");
		await startServer({ listen: `unix:${path}` } as any, fakeRouter, catalog);
		const c = await client(path);
		expect((await c.request("tools/list", {})).result.tools).toEqual(catalog);
	});

	it("applies the configured socket group when it resolves", async () => {
		const path = sockPath("group.sock");
		// the process's own primary group always resolves and is chown-able by the owner
		const gid = process.getgid!();
		const groupLine = `testgrp:x:${gid}:\n`;
		vi.mocked(readFileSync).mockImplementationOnce(((p: any, ...rest: any[]) => (p === "/etc/group" ? groupLine : undefined)) as any);
		process.env.GH_BROKER_SOCKET_GROUP = "testgrp";
		await startServer({ listen: `unix:${path}` } as any, fakeRouter, catalog);
		expect(statSync(path).gid).toBe(gid);
	});

	it("still listens when the group is unknown or /etc/group is unreadable", async () => {
		process.env.GH_BROKER_SOCKET_GROUP = "no-such-group-xyz";
		await startServer({ listen: `unix:${sockPath("nogroup.sock")}` } as any, fakeRouter, catalog);

		vi.mocked(readFileSync).mockImplementationOnce((() => {
			throw new Error("EACCES");
		}) as any);
		await startServer({ listen: `unix:${sockPath("unreadable.sock")}` } as any, fakeRouter, catalog);
	});

	it("tolerates a failed chown (group the process cannot assign)", async () => {
		const path = sockPath("chownfail.sock");
		// gid 0 (root) is not assignable by an unprivileged owner → chownSync throws, which is swallowed
		vi.mocked(readFileSync).mockImplementationOnce((() => "rootish:x:0:\n") as any);
		process.env.GH_BROKER_SOCKET_GROUP = "rootish";
		await startServer({ listen: `unix:${path}` } as any, fakeRouter, catalog);
		const c = await client(path);
		expect((await c.request("tools/list", {})).result.tools).toEqual(catalog);
	});

	it("survives garbage from a client without taking the server down", async () => {
		const path = sockPath("garbage.sock");
		await startServer({ listen: `unix:${path}` } as any, fakeRouter, catalog);
		const bad = await client(path);
		bad.sock.write("not json\n");
		await new Promise((r) => setTimeout(r, 50));
		bad.sock.destroy();
		const good = await client(path);
		expect((await good.request("tools/list", {})).result.tools).toEqual(catalog);
	});

	it("ignores an error on a client socket", async () => {
		const path = sockPath("hangup.sock");
		await startServer({ listen: `unix:${path}` } as any, fakeRouter, catalog);
		const c = await client(path);
		await c.request("tools/list", {});
		const serverSide = seen.sockets.at(-1);
		expect(() => serverSide.emit("error", new Error("ECONNRESET"))).not.toThrow();
		expect((await c.request("tools/list", {})).result.tools).toEqual(catalog);
	});

	it("tolerates a failing MCP close when the client goes away", async () => {
		const path = sockPath("closefail.sock");
		await startServer({ listen: `unix:${path}` } as any, fakeRouter, catalog);
		const close = vi.spyOn(McpServer.prototype, "close").mockRejectedValue(new Error("close failed"));
		const c = await client(path);
		await c.request("tools/list", {});
		c.sock.destroy();
		await vi.waitFor(() => expect(close).toHaveBeenCalled());
	});

	it("logs and drops a connection whose MCP transport fails to start", async () => {
		const path = sockPath("connectfail.sock");
		await startServer({ listen: `unix:${path}` } as any, fakeRouter, catalog);
		vi.spyOn(McpServer.prototype, "connect").mockRejectedValue(new Error("transport broke"));
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const c = await client(path);
		await new Promise<void>((resolve) => c.sock.once("close", () => resolve()));
		expect(err).toHaveBeenCalledWith("gh-broker: connection error: transport broke");
	});

	it("chowns with uid -1 when process.getuid is unavailable", async () => {
		const orig = process.getuid;
		const path = sockPath("nouid.sock");
		const gid = process.getgid!();
		vi.mocked(readFileSync).mockImplementationOnce(((p: any) => (p === "/etc/group" ? `testgrp:x:${gid}:\n` : undefined)) as any);
		process.env.GH_BROKER_SOCKET_GROUP = "testgrp";
		(process as any).getuid = undefined;
		try {
			await startServer({ listen: `unix:${path}` } as any, fakeRouter, catalog);
		} finally {
			process.getuid = orig;
		}
		expect(statSync(path).mode & 0o777).toBe(0o660);
	});
});
