import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { smokeTest } from "../deploy/lib/smoke.mjs";

// Real node:net, except connect() lets a test grab the client socket (to inject an error on it).
const hook = vi.hoisted(() => ({ onSock: null as null | ((s: any) => void) }));
vi.mock("node:net", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:net")>();
	return {
		...actual,
		connect: (...a: any[]) => {
			const sock = (actual.connect as any)(...a);
			hook.onSock?.(sock);
			return sock;
		}
	};
});

const root = join(process.cwd(), "tmp", "tests", "smoke");
mkdirSync(root, { recursive: true });
let n = 0;
const servers: Server[] = [];
const conns: Socket[] = [];

type Handler = (msg: any, sock: Socket) => void;

/** A fake broker on a real unix socket; `onMsg` answers each newline-delimited JSON-RPC message. */
function fakeBroker(path: string, onMsg: Handler, onConn?: (s: Socket) => void): Promise<Server> {
	return new Promise((resolve) => {
		const srv = createServer((sock) => {
			conns.push(sock);
			if (onConn) return onConn(sock);
			let buf = "";
			sock.on("data", (d) => {
				buf += d.toString("utf8");
				let nl;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					onMsg(JSON.parse(line), sock);
				}
			});
			sock.on("error", () => {});
		});
		servers.push(srv);
		srv.listen(path, () => resolve(srv));
	});
}

const reply = (sock: Socket, id: number, result: unknown) => sock.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const replyErr = (sock: Socket, id: number, error: unknown) => sock.write(JSON.stringify({ jsonrpc: "2.0", id, error }) + "\n");
const path = () => {
	const p = join(root, `s${++n}.sock`);
	rmSync(p, { force: true }); // a socket left behind by an earlier run
	return p;
};

afterEach(async () => {
	for (const c of conns.splice(0)) c.destroy();
	await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

describe("smokeTest", () => {
	it("handshakes, lists tools and round-trips get_me", async () => {
		const p = path();
		await fakeBroker(p, (m, s) => {
			if (m.method === "initialize") reply(s, m.id, {});
			else if (m.method === "tools/list") reply(s, m.id, { tools: [{ name: "get_me" }, { name: "other" }] });
			else if (m.method === "tools/call") reply(s, m.id, { content: [] });
		});
		expect(await smokeTest(p)).toEqual({ tools: ["get_me", "other"], roundTrip: "get_me ok" });
	});

	it("reports an isError get_me, and a failing get_me", async () => {
		const p1 = path();
		await fakeBroker(p1, (m, s) => {
			if (m.method === "tools/list") reply(s, m.id, { tools: [{ name: "get_me" }] });
			else if (m.method === "tools/call") reply(s, m.id, { isError: true });
			else if (m.id) reply(s, m.id, {});
		});
		expect((await smokeTest(p1)).roundTrip).toBe("get_me returned an error");

		const p2 = path();
		await fakeBroker(p2, (m, s) => {
			if (m.method === "tools/list") reply(s, m.id, { tools: [{ name: "get_me" }] });
			else if (m.method === "tools/call") replyErr(s, m.id, { message: "denied" });
			else if (m.id) reply(s, m.id, {});
		});
		expect((await smokeTest(p2)).roundTrip).toBe("get_me failed: denied");
	});

	it("skips the round trip when get_me is not advertised, tolerating an empty list result", async () => {
		const p = path();
		await fakeBroker(p, (m, s) => {
			if (m.method === "tools/list") reply(s, m.id, {});
			else if (m.id) reply(s, m.id, {});
		});
		expect(await smokeTest(p)).toEqual({ tools: [], roundTrip: null });
	});

	it("ignores blank lines, garbage and unknown ids, and reassembles split lines", async () => {
		const p = path();
		await fakeBroker(p, (m, s) => {
			if (m.method === "initialize") {
				s.write("\n   \nnot-json\n");
				s.write(JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }) + "\n");
				const full = JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\n";
				s.write(full.slice(0, 5));
				setTimeout(() => s.write(full.slice(5)), 20);
			} else if (m.method === "tools/list") reply(s, m.id, { tools: [] });
		});
		expect((await smokeTest(p)).tools).toEqual([]);
	});

	it("rejects with the rpc error message, falling back to a generic one", async () => {
		const p1 = path();
		await fakeBroker(p1, (m, s) => replyErr(s, m.id, { message: "bad init" }));
		await expect(smokeTest(p1)).rejects.toThrow("bad init");

		const p2 = path();
		await fakeBroker(p2, (m, s) => replyErr(s, m.id, {}));
		await expect(smokeTest(p2)).rejects.toThrow("rpc error");
	});

	it("retries until the socket appears", async () => {
		const p = path();
		const pending = smokeTest(p, { timeoutMs: 5000 });
		await new Promise((r) => setTimeout(r, 400)); // first attempts hit ENOENT
		await fakeBroker(p, (m, s) => {
			if (m.method === "tools/list") reply(s, m.id, { tools: [] });
			else if (m.id) reply(s, m.id, {});
		});
		expect((await pending).tools).toEqual([]);
	});

	it("retries on ECONNREFUSED (stale socket file with no listener) until the deadline", async () => {
		const p = path();
		// a child binds the socket and is SIGKILLed, leaving the socket file behind with nobody listening
		const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(p)}, () => console.log("up"))`], {
			stdio: ["ignore", "pipe", "inherit"]
		});
		await new Promise((r) => child.stdout.once("data", r));
		child.kill("SIGKILL");
		await new Promise((r) => child.once("exit", r));
		await expect(smokeTest(p, { timeoutMs: 600 })).rejects.toThrow(/smoke: socket error .*ECONNREFUSED/);
	});

	it("gives up once the deadline passes", async () => {
		await expect(smokeTest(path(), { timeoutMs: 300 })).rejects.toThrow(/smoke: socket error .*ENOENT/);
	});

	it("fails immediately on a non-retryable connect error", async () => {
		const file = join(root, "plainfile");
		writeFileSync(file, "x");
		await expect(smokeTest(join(file, "child.sock"), { timeoutMs: 5000 })).rejects.toThrow(/smoke: socket error/);
	});

	it("rejects when the broker never answers", async () => {
		const p = path();
		await fakeBroker(p, () => {});
		await expect(smokeTest(p, { timeoutMs: 100 })).rejects.toThrow("smoke: no response before deadline");
	});

	it("rejects when the socket errors mid-handshake", async () => {
		const p = path();
		await fakeBroker(p, () => {});
		hook.onSock = (sock) => sock.once("connect", () => setTimeout(() => sock.emit("error", new Error("boom")), 30));
		try {
			await expect(smokeTest(p)).rejects.toThrow("smoke: socket error: boom");
		} finally {
			hook.onSock = null;
		}
	});
});
