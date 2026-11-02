import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { connect, type Socket } from "node:net";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { startServer } from "../src/server.ts";

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

// Real node:fs, except chmodSync on a socket can be made to fail for one test.
const fsFail = vi.hoisted(() => ({ chmod: false }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
			if (fsFail.chmod && String(args[0]).endsWith(".sock")) throw Object.assign(new Error("ENOENT: no such file or directory, chmod"), { code: "ENOENT" });
			return actual.chmodSync(...args);
		}
	};
});

const root = join(process.cwd(), "tmp", "tests", "server");
const fakeRouter: any = {
	call: vi.fn(async (name: string, args: unknown, caller: { user: string }) => ({ content: [{ type: "text", text: `${caller.user}:${name}:${JSON.stringify(args)}` }] }))
};
const catalog: any[] = [{ name: "get_me", description: "me", inputSchema: { type: "object" } }];
const sockets: Socket[] = [];
// The test process can always hand a socket to its own primary group.
const GID = process.getgid!();
let n = 0;

/** A fresh case directory holding a group file and the agents dir (not yet created). */
function setup(groupLines: string[]) {
	const caseDir = join(root, `c${n++}`);
	rmSync(caseDir, { recursive: true, force: true });
	mkdirSync(caseDir, { recursive: true });
	const groupFile = join(caseDir, "group");
	writeFileSync(groupFile, groupLines.join("\n") + "\n");
	const dir = join(caseDir, "agents");
	return { caseDir, groupFile, dir, config: { listen: `agents:${dir}` } as any };
}

const agentLine = (user: string, gid = GID) => `gh-broker-agent-${user}:x:${gid}:gh-broker,${user}`;

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
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("startServer", () => {
	it("rejects a listen value that isn't agents:<abs dir>", async () => {
		await expect(startServer({ listen: "unix:/run/x.sock" } as any, fakeRouter, catalog)).rejects.toThrow('server: unsupported listen "unix:/run/x.sock" (expected "agents:<absolute dir>")');
	});

	it("listens on one socket per agent, 0660 in the agent's group, and tags each call with that agent", async () => {
		const h = setup(["root:x:0:", agentLine("repo"), agentLine("glmtest")]);
		const users = await startServer(h.config, fakeRouter, catalog, { groupFile: h.groupFile });
		expect(users).toEqual(["repo", "glmtest"]);
		expect(statSync(h.dir).mode & 0o777).toBe(0o755);
		for (const u of users) {
			const st = statSync(join(h.dir, `${u}.sock`));
			expect(st.mode & 0o777).toBe(0o660);
			expect(st.gid).toBe(GID);
		}

		const repo = await client(join(h.dir, "repo.sock"));
		const init = await repo.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
		expect(init.result.serverInfo.name).toBe("gh-broker");
		expect((await repo.request("tools/list", {})).result.tools).toEqual(catalog);
		expect((await repo.request("tools/call", { name: "get_me", arguments: { a: 1 } })).result.content[0].text).toBe('repo:get_me:{"a":1}');
		// arguments omitted → router receives {}
		expect((await repo.request("tools/call", { name: "get_me" })).result.content[0].text).toBe("repo:get_me:{}");

		const glm = await client(join(h.dir, "glmtest.sock"));
		expect((await glm.request("tools/call", { name: "get_me", arguments: {} })).result.content[0].text).toBe("glmtest:get_me:{}");
		repo.sock.destroy();
		await new Promise((r) => setTimeout(r, 50));
	});

	it("keeps an existing directory's mode, replaces a stale socket and removes sockets of unregistered agents", async () => {
		const h = setup([agentLine("repo")]);
		mkdirSync(h.dir, { mode: 0o750 });
		writeFileSync(join(h.dir, "repo.sock"), "");
		writeFileSync(join(h.dir, "gone.sock"), "");
		writeFileSync(join(h.dir, "notes.txt"), "");
		await startServer(h.config, fakeRouter, catalog, { groupFile: h.groupFile });
		expect(readdirSync(h.dir).sort()).toEqual(["notes.txt", "repo.sock"]);
		expect(statSync(h.dir).mode & 0o777).toBe(0o750);
		const c = await client(join(h.dir, "repo.sock"));
		expect((await c.request("tools/list", {})).result.tools).toEqual(catalog);
	});

	it("serves nothing, without failing, when no agent is registered", async () => {
		const h = setup(["root:x:0:", "gh-broker-clients:x:991:gh-broker,repo", "gh-broker-agent-bad:x:5:bad"]);
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await startServer(h.config, fakeRouter, catalog, { groupFile: h.groupFile })).toEqual([]);
		expect(readdirSync(h.dir)).toEqual([]);
		expect(err).toHaveBeenCalledWith("gh-broker: ignoring agent group gh-broker-agent-bad: members must be exactly gh-broker and bad");
		expect(err).toHaveBeenCalledWith(
			"gh-broker: no agents registered (no gh-broker-agent-<user> group with members gh-broker and <user>); serving nothing. Add one with: sudo gh-broker agent add <user>"
		);
	});

	it("serves nothing when the group file can't be read", async () => {
		const h = setup([]);
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await startServer(h.config, fakeRouter, catalog, { groupFile: join(h.caseDir, "missing") })).toEqual([]);
		expect(err).toHaveBeenCalledWith(expect.stringMatching(/^gh-broker: cannot read .*missing \(.*\); serving no agents$/));
	});

	it("reads /etc/group by default", async () => {
		const h = setup([]);
		vi.spyOn(console, "error").mockImplementation(() => {});
		// The build host's real group file has no agent groups (or the test would see them): either way it resolves.
		await expect(startServer(h.config, fakeRouter, catalog)).resolves.toBeInstanceOf(Array);
	});

	it.skipIf(process.getuid?.() === 0)("fails closed and says so when the socket can't be given to the agent's group", async () => {
		// gid 0 (root) is not assignable by an unprivileged owner, so the socket keeps the service's own group.
		const h = setup([agentLine("repo", 0)]);
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		await startServer(h.config, fakeRouter, catalog, { groupFile: h.groupFile });
		const st = statSync(join(h.dir, "repo.sock"));
		expect(st.mode & 0o777).toBe(0o660);
		expect(st.gid).not.toBe(0);
		expect(err).toHaveBeenCalledWith(expect.stringMatching(/cannot give .*repo\.sock to group gh-broker-agent-repo \(.*\); repo can't connect/));
	});

	it("rejects, and stops listening, when the socket can't be set to 0660", async () => {
		const h = setup([agentLine("repo")]);
		fsFail.chmod = true;
		try {
			await expect(startServer(h.config, fakeRouter, catalog, { groupFile: h.groupFile })).rejects.toThrow(/ENOENT/);
		} finally {
			fsFail.chmod = false;
		}
		await expect(client(join(h.dir, "repo.sock"))).rejects.toBeTruthy();
	});

	it("rejects when a socket cannot be bound", async () => {
		const h = setup([agentLine("repo")]);
		// A socket path longer than sun_path (108 bytes) can't be bound.
		const deep = join(h.caseDir, "x".repeat(120));
		await expect(startServer({ listen: `agents:${deep}` } as any, fakeRouter, catalog, { groupFile: h.groupFile })).rejects.toBeTruthy();
		expect(existsSync(deep)).toBe(true);
	});

	it("survives garbage from a client without taking the server down", async () => {
		const h = setup([agentLine("repo")]);
		await startServer(h.config, fakeRouter, catalog, { groupFile: h.groupFile });
		const path = join(h.dir, "repo.sock");
		const bad = await client(path);
		bad.sock.write("not json\n");
		await new Promise((r) => setTimeout(r, 50));
		bad.sock.destroy();
		const good = await client(path);
		expect((await good.request("tools/list", {})).result.tools).toEqual(catalog);
	});

	it("ignores an error on a client socket", async () => {
		const h = setup([agentLine("repo")]);
		await startServer(h.config, fakeRouter, catalog, { groupFile: h.groupFile });
		const c = await client(join(h.dir, "repo.sock"));
		await c.request("tools/list", {});
		const serverSide = seen.sockets.at(-1);
		expect(() => serverSide.emit("error", new Error("ECONNRESET"))).not.toThrow();
		expect((await c.request("tools/list", {})).result.tools).toEqual(catalog);
	});

	it("tolerates a failing MCP close when the client goes away", async () => {
		const h = setup([agentLine("repo")]);
		await startServer(h.config, fakeRouter, catalog, { groupFile: h.groupFile });
		const close = vi.spyOn(McpServer.prototype, "close").mockRejectedValue(new Error("close failed"));
		const c = await client(join(h.dir, "repo.sock"));
		await c.request("tools/list", {});
		c.sock.destroy();
		await vi.waitFor(() => expect(close).toHaveBeenCalled());
	});

	it("logs and drops a connection whose MCP transport fails to start", async () => {
		const h = setup([agentLine("repo")]);
		await startServer(h.config, fakeRouter, catalog, { groupFile: h.groupFile });
		vi.spyOn(McpServer.prototype, "connect").mockRejectedValue(new Error("transport broke"));
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const c = await client(join(h.dir, "repo.sock"));
		await new Promise<void>((resolve) => c.sock.once("close", () => resolve()));
		expect(err).toHaveBeenCalledWith("gh-broker: connection error: transport broke");
	});

	it("chowns with uid -1 when process.getuid is unavailable", async () => {
		const orig = process.getuid;
		const h = setup([agentLine("repo")]);
		(process as any).getuid = undefined;
		try {
			await startServer(h.config, fakeRouter, catalog, { groupFile: h.groupFile });
		} finally {
			process.getuid = orig;
		}
		expect(statSync(join(h.dir, "repo.sock")).gid).toBe(GID);
	});
});
