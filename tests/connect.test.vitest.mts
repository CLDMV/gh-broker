import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONNECT_HELP, runBridge, type ConnectDeps } from "../src/cli/connect.ts";

// The bridge against a real Unix socket: a small line-framed fake broker (it answers initialize,
// echoes everything else back, and can be told to kick the connection or refuse dials), driven
// through a PassThrough stdin with the client's stdout collected. The injected sleep records what
// it was asked for and really waits, with small backoff/hold overrides so the restart tests are fast.

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Poll until `what` holds, so the tests assert on outcomes rather than sleeping through timings. */
async function waitFor(what: () => boolean, ms = 4000): Promise<void> {
	const start = Date.now();
	while (!what()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting");
		await realSleep(5);
	}
}

const initReq = (id: number): string =>
	JSON.stringify({
		jsonrpc: "2.0",
		id,
		method: "initialize",
		params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } }
	});
const initNotify = (): string => JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
const req = (id: number, method = "tools/call"): string => JSON.stringify({ jsonrpc: "2.0", id, method, params: {} });
const isResponse = (id: number) => (l: string) => l.includes(`"id":${id}`) && l.includes('"result"');
const isStale = (id: number | string) => (l: string) => l.includes("-32000") && l.includes(`"id":${JSON.stringify(id)}`);
const isListChanged = (l: string): boolean => l.includes("notifications/tools/list_changed");

/** A fake broker: line-framed JSON-RPC over a real Unix socket. */
class FakeBroker {
	private server: Server | null = null;
	private buf = "";
	private sockets = new Set<Socket>();
	readonly received: string[] = [];
	connections = 0;
	/** Answer an initialize request with a result response (everything else is echoed verbatim). */
	answerInitialize = true;
	/** Echo non-initialize lines back. */
	echo = true;
	/** Called with each new connection, after it is recorded. */
	onConnection: ((sock: Socket) => void) | null = null;

	constructor(readonly path: string) {}

	async start(): Promise<void> {
		const server = createServer((sock) => {
			this.connections++;
			this.sockets.add(sock);
			sock.setEncoding("utf8");
			sock.on("data", (chunk: string) => {
				this.buf += chunk;
				for (let nl = this.buf.indexOf("\n"); nl >= 0; nl = this.buf.indexOf("\n")) {
					const line = this.buf.slice(0, nl);
					this.buf = this.buf.slice(nl + 1);
					this.onLine(line, sock);
				}
			});
			sock.on("close", () => this.sockets.delete(sock));
			sock.on("error", () => {}); // the bridge may destroy the socket mid-echo (EPIPE) — normal
			this.onConnection?.(sock);
		});
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.path, () => resolve());
		});
	}

	private onLine(line: string, sock: Socket): void {
		this.received.push(line);
		let msg: { id?: unknown; method?: unknown };
		try {
			msg = JSON.parse(line);
		} catch {
			if (this.echo) sock.write(`${line}\n`);
			return;
		}
		if (msg.method === "initialize" && this.answerInitialize) {
			sock.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "0.0.0" } } })}\n`
			);
			return;
		}
		if (this.echo) sock.write(`${line}\n`);
	}

	/** Destroy the connection(s) the way a broker restart does, keeping the listener up. */
	kick(): void {
		for (const s of this.sockets) s.destroy();
	}

	/** Write a line to the bridge (server → client). */
	write(line: string): void {
		for (const s of this.sockets) s.write(`${line}\n`);
	}

	/** Answer one request id. */
	respond(id: unknown, result: unknown): void {
		this.write(JSON.stringify({ jsonrpc: "2.0", id, result }));
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		for (const s of this.sockets) s.destroy();
		if (!server) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

/** The client side of the bridge: stdout collected line by line, with a wait-for-line helper. */
class ClientLines {
	private buf = "";
	private waiters: Array<{ pred: (l: string) => boolean; resolve: (l: string) => void }> = [];
	readonly lines: string[] = [];

	constructor(stream: PassThrough) {
		stream.setEncoding("utf8");
		stream.on("data", (chunk: string) => {
			this.buf += chunk;
			for (let nl = this.buf.indexOf("\n"); nl >= 0; nl = this.buf.indexOf("\n")) {
				const line = this.buf.slice(0, nl);
				this.buf = this.buf.slice(nl + 1);
				this.lines.push(line);
				const w = this.waiters.find((x) => x.pred(line));
				if (w) {
					this.waiters = this.waiters.filter((x) => x !== w);
					w.resolve(line);
				}
			}
		});
	}

	waitNext(pred: (l: string) => boolean, ms = 4000): Promise<string> {
		const hit = this.lines.find(pred);
		if (hit !== undefined) return Promise.resolve(hit);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no matching line; have: ${JSON.stringify(this.lines)}`)), ms);
			this.waiters.push({
				pred,
				resolve: (l: string) => {
					clearTimeout(timer);
					resolve(l);
				}
			});
		});
	}
}

interface Bridge {
	deps: ConnectDeps;
	stdin: PassThrough;
	stdout: PassThrough;
	done: Promise<number>;
	logs: string[];
	sleeps: number[];
	client: ClientLines;
}

const bridges: Bridge[] = [];
const brokers: FakeBroker[] = [];

function startBridge(path: string, over: Partial<ConnectDeps> = {}): Bridge {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const logs: string[] = [];
	const sleeps: number[] = [];
	const deps: ConnectDeps = {
		stdin,
		stdout,
		log: (m) => logs.push(m),
		connect: (p) =>
			new Promise((resolve, reject) => {
				const sock = netConnect(p);
				sock.once("connect", () => resolve(sock));
				sock.once("error", reject);
			}),
		sleep: async (ms) => {
			sleeps.push(ms);
			await new Promise<void>((resolve) => {
				const t = setTimeout(resolve, ms);
				t.unref(); // as the real dep: a pending hold/backoff timer must not keep the worker alive
			});
		},
		backoffStartMs: 5,
		backoffMaxMs: 20,
		holdMs: 200,
		...over
	};
	const b: Bridge = { deps, stdin, stdout, done: runBridge([path], deps), logs, sleeps, client: new ClientLines(stdout) };
	bridges.push(b);
	return b;
}

async function startBroker(path: string): Promise<FakeBroker> {
	const broker = new FakeBroker(path);
	await broker.start();
	brokers.push(broker);
	return broker;
}

let dir = "";
let sockN = 0;
const nextSock = (): string => join(dir, `s${sockN++}.sock`);

afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
	mkdirSync(join(process.cwd(), "tmp", "agents"), { recursive: true });
	dir = mkdtempSync(join(process.cwd(), "tmp", "agents", "connect-test-"));
});

afterEach(async () => {
	while (bridges.length) {
		const b = bridges.pop()!;
		b.stdin.end();
		await Promise.race([b.done.catch(() => {}), realSleep(2000)]);
	}
	while (brokers.length) await brokers.pop()!.stop();
});

describe("usage", () => {
	it("prints help and exits 2 for anything but exactly one absolute socket path", async () => {
		const logs: string[] = [];
		const deps: ConnectDeps = {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			log: (m) => logs.push(m),
			connect: () => Promise.reject(new Error("not dialed")),
			sleep: async () => {}
		};
		for (const argv of [[], ["relative.sock"], ["/run/x.sock", "/run/y.sock"]]) {
			expect(await runBridge(argv, deps)).toBe(2);
			expect(logs).toEqual([CONNECT_HELP]);
			logs.length = 0;
		}
	});
});

describe("pipe", () => {
	it("forwards client lines to the socket and socket lines to the client, byte for byte", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path);
		await waitFor(() => broker.connections === 1);
		b.stdin.write(`${req(1, "tools/list")}\n`);
		// one line split across two writes is still one line
		b.stdin.write('{"jsonrpc":"2.0","id":2,"method":"to');
		b.stdin.write('ols/call","params":{}}\n');
		await waitFor(() => broker.received.length >= 2);
		expect(broker.received[0]).toBe(req(1, "tools/list"));
		expect(broker.received[1]).toBe('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{}}');
		// echoed back, and a two-line chunk from the server arrives as two lines
		await waitFor(() => b.client.lines.length >= 2);
		expect(b.client.lines[0]).toBe(req(1, "tools/list"));
		broker.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/x", params: {} }));
		broker.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/y", params: {} }));
		await waitFor(() => b.client.lines.length >= 4);
		expect(b.client.lines[2]).toContain("notifications/x");
		expect(b.client.lines[3]).toContain("notifications/y");
	});

	it("flushes a partial last line on stdin EOF and exits 0 with the socket closed", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path);
		await waitFor(() => broker.connections === 1);
		b.stdin.write('{"jsonrpc":"2.0","id":5,"method":"to');
		b.stdin.end();
		await waitFor(() => broker.received[0] === '{"jsonrpc":"2.0","id":5,"method":"to');
		expect(await b.done).toBe(0);
		await waitFor(() => broker.sockets.size === 0);
	});
});

describe("handshake replay after a restart", () => {
	it("replays initialize + initialized, swallows the duplicate response, and sends list_changed", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path);
		await waitFor(() => broker.connections === 1);
		b.stdin.write(`${initReq(1)}\n${initNotify()}\n`);
		await b.client.waitNext(isResponse(1)); // the client sees its initialize answer exactly once
		broker.kick();
		await waitFor(() => broker.connections === 2);
		await b.client.waitNext(isListChanged);
		// both handshake lines were replayed to the new socket
		expect(broker.received.filter((l) => l === initReq(1))).toHaveLength(2);
		expect(broker.received.filter((l) => l === initNotify())).toHaveLength(2);
		// the replayed initialize response was swallowed: still exactly one for the client
		expect(b.client.lines.filter(isResponse(1))).toHaveLength(1);
		// and the bridge works again
		b.stdin.write(`${req(2, "tools/list")}\n`);
		await waitFor(() => broker.received.some((l) => l === req(2, "tools/list")));
		await b.client.waitNext(isResponse(2));
		expect(b.logs).toContain(`bridge: connected to ${broker.path}`);
		expect(b.logs).toContain("bridge: socket closed; retrying in 5ms");
	});

	it("queues server lines during the replay wait and sends list_changed before them", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path);
		await waitFor(() => broker.connections === 1);
		b.stdin.write(`${initReq(1)}\n${initNotify()}\n`);
		await b.client.waitNext(isResponse(1));
		broker.onConnection = () => broker.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/early", params: {} }));
		broker.kick();
		await b.client.waitNext(isListChanged);
		await b.client.waitNext((l) => l.includes("notifications/early"));
		const changed = b.client.lines.findIndex(isListChanged);
		const early = b.client.lines.findIndex((l) => l.includes("notifications/early"));
		expect(changed).toBeGreaterThanOrEqual(0);
		expect(early).toBeGreaterThan(changed);
	});

	it("re-dials and replays again when the socket dies during the replay wait", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path);
		await waitFor(() => broker.connections === 1);
		b.stdin.write(`${initReq(1)}\n${initNotify()}\n`);
		await b.client.waitNext(isResponse(1));
		broker.answerInitialize = false; // connection 2: the replayed initialize gets no answer
		broker.kick();
		await waitFor(() => broker.received.filter((l) => l === initReq(1)).length >= 2);
		broker.kick(); // die mid-replay-wait
		broker.answerInitialize = true;
		await waitFor(() => broker.connections >= 3);
		await b.client.waitNext(isListChanged);
		expect(b.client.lines.filter(isListChanged)).toHaveLength(1);
		expect(b.client.lines.filter(isStale(1))).toHaveLength(0);
		expect(b.client.lines.filter(isResponse(1))).toHaveLength(1); // the replayed answers stay swallowed
	});

	it("forwards a handshake captured while dialing on the first connection, and replays it on the next", async () => {
		const path = nextSock();
		const b = startBridge(path, { backoffStartMs: 30, backoffMaxMs: 60 });
		b.stdin.write(`${initReq(1)}\n${initNotify()}\n`); // no server yet: held
		await waitFor(() => b.logs.some((l) => l.includes("cannot connect")));
		const broker = await startBroker(path);
		await waitFor(() => broker.connections === 1);
		// the first connection forwards the held handshake live: the client gets its answer
		await waitFor(() => broker.received.some((l) => l === initReq(1)));
		await waitFor(() => broker.received.some((l) => l === initNotify()));
		await b.client.waitNext(isResponse(1));
		// and the second connection replays the recorded handshake
		broker.kick();
		await waitFor(() => broker.received.filter((l) => l === initReq(1)).length >= 2);
		await b.client.waitNext(isListChanged);
		expect(b.client.lines.filter(isResponse(1))).toHaveLength(1);
	});
});

describe("requests across a disconnect", () => {
	it("replies -32000 with the request's own id to one in flight when the socket closes", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path);
		await waitFor(() => broker.connections === 1);
		broker.echo = false; // the request stays unanswered: in flight
		b.stdin.write(`${req(7)}\n`);
		await waitFor(() => broker.received.some((l) => l === req(7)));
		broker.kick();
		const line = await b.client.waitNext(isStale(7));
		expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32000, message: "gh-broker restarted; retry" } });
	});

	it("replies -32000 with a string id too", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path);
		await waitFor(() => broker.connections === 1);
		broker.echo = false;
		const sent = JSON.stringify({ jsonrpc: "2.0", id: "abc", method: "tools/call", params: {} });
		b.stdin.write(`${sent}\n`);
		await waitFor(() => broker.received.some((l) => l === sent));
		broker.kick();
		const line = await b.client.waitNext((l) => l.includes("-32000"));
		expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: "abc", error: { code: -32000, message: "gh-broker restarted; retry" } });
	});

	it("holds a request sent while disconnected and forwards it after reconnecting", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path, { backoffStartMs: 150, backoffMaxMs: 300, holdMs: 5000 });
		await waitFor(() => broker.connections === 1);
		b.stdin.write(`${initReq(1)}\n${initNotify()}\n`);
		await b.client.waitNext(isResponse(1));
		broker.kick();
		await waitFor(() => b.logs.some((l) => l.startsWith("bridge: socket closed"))); // down, not yet dialing
		b.stdin.write(`${req(8)}\n`); // arrives while the socket is down: held
		await b.client.waitNext(isListChanged); // reconnect + replay happened
		await waitFor(() => broker.received.some((l) => l === req(8)));
		// the held request went after the replayed handshake, and the client was never errored for it
		expect(broker.received.indexOf(req(8))).toBeGreaterThan(broker.received.lastIndexOf(initReq(1)));
		expect(b.client.lines.filter(isStale(8))).toHaveLength(0);
		broker.respond(8, { ok: true });
		await b.client.waitNext(isResponse(8));
	});

	it("errors a request held past holdMs, without hanging the client", async () => {
		const path = nextSock(); // never any server
		const b = startBridge(path, { backoffStartMs: 50, backoffMaxMs: 100, holdMs: 40 });
		await waitFor(() => b.logs.some((l) => l.includes("cannot connect")));
		b.stdin.write(`${req(9)}\n`);
		const line = await b.client.waitNext(isStale(9), 2000);
		expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: 9, error: { code: -32000, message: "gh-broker restarted; retry" } });
		let resolved = false;
		void b.done.then(() => (resolved = true));
		await realSleep(30);
		expect(resolved).toBe(false); // socket trouble never exits the bridge
	});

	it("holds notifications and unparseable lines with no timeout and forwards them verbatim", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path, { backoffStartMs: 400, backoffMaxMs: 800, holdMs: 20 });
		await waitFor(() => broker.connections === 1);
		b.stdin.write(`${initReq(1)}\n${initNotify()}\n`);
		await b.client.waitNext(isResponse(1));
		broker.kick();
		await waitFor(() => b.logs.some((l) => l.startsWith("bridge: socket closed")));
		const note = JSON.stringify({ jsonrpc: "2.0", method: "notifications/queued", params: {} });
		b.stdin.write(`${note}\nnot json at all\n`);
		await realSleep(100); // far past holdMs: still no error, nothing is waiting on these
		expect(b.client.lines.filter((l) => l.includes("-32000"))).toHaveLength(0);
		await b.client.waitNext(isListChanged); // the reconnect at ~400ms
		await waitFor(() => broker.received.includes(note) && broker.received.includes("not json at all"));
	});

	it("does not error held requests after stdin EOF", async () => {
		const path = nextSock(); // never any server
		const b = startBridge(path, { backoffStartMs: 5, backoffMaxMs: 10, holdMs: 20 });
		await waitFor(() => b.logs.some((l) => l.includes("cannot connect")));
		b.stdin.write('{"jsonrpc":"2.0","id":9,'); // a partial line, held with the rest
		b.stdin.end();
		expect(await b.done).toBe(0);
		await realSleep(60); // past holdMs: the expiry must not write to the client after EOF
		expect(b.client.lines).toEqual([]);
	});
});

describe("dialing", () => {
	it("retries a failed dial with a backoff and connects when the server appears", async () => {
		const path = nextSock();
		const b = startBridge(path, { backoffStartMs: 5, backoffMaxMs: 20 });
		await waitFor(() => b.sleeps.length >= 2);
		expect(b.logs[0]).toBe(`bridge: cannot connect to ${path}; retrying in 5ms`);
		const broker = await startBroker(path);
		await waitFor(() => broker.connections === 1);
		b.stdin.write(`${initReq(1)}\n`);
		await b.client.waitNext(isResponse(1));
	});

	it("doubles the backoff, caps it, and resets it after a successful connection", async () => {
		const path = nextSock();
		const b = startBridge(path, { backoffStartMs: 5, backoffMaxMs: 12 });
		await waitFor(() => b.sleeps.length >= 3);
		expect(b.sleeps.slice(0, 3)).toEqual([5, 10, 12]);
		const broker = await startBroker(path);
		await waitFor(() => broker.connections === 1);
		const before = b.sleeps.length;
		broker.kick();
		await waitFor(() => b.sleeps.length > before);
		expect(b.sleeps[before]).toBe(5); // the restart's first retry is back at the start
	});

	it("ignores a dial that resolves after stdin EOF, and exits anyway", async () => {
		const broker = await startBroker(nextSock());
		let release!: (sock: Socket) => void;
		const gate = new Promise<Socket>((resolve) => (release = resolve));
		const b = startBridge(broker.path, { connect: () => gate });
		b.stdin.end(); // EOF while the dial is still pending
		expect(await b.done).toBe(0);
		await new Promise<void>((resolve) => {
			const sock = netConnect(broker.path);
			sock.once("connect", () => {
				release(sock);
				resolve();
			});
		});
		await realSleep(30);
		expect(b.logs.some((l) => l.startsWith("bridge: connected"))).toBe(false);
		await waitFor(() => broker.sockets.size === 0); // the late socket was destroyed, not adopted
	});
});

describe("stdout", () => {
	it("keeps running when the client's stdout errors", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path);
		await waitFor(() => broker.connections === 1);
		b.stdout.emit("error", new Error("EPIPE")); // must not take the bridge down
		b.stdin.write(`${initReq(1)}\n`);
		await waitFor(() => broker.received.some((l) => l === initReq(1)));
		b.stdin.end();
		expect(await b.done).toBe(0);
	});
});

describe("defaults", () => {
	it("runs with the built-in backoff and hold when no overrides are given", async () => {
		const path = nextSock(); // never any server
		const b = startBridge(path, { backoffStartMs: undefined, backoffMaxMs: undefined, holdMs: undefined });
		await waitFor(() => b.sleeps.length >= 1, 2000);
		expect(b.sleeps[0]).toBe(250);
		// a request held while down (30s hold) plus stdin EOF: exits 0 without waiting for it
		b.stdin.write(`${req(3)}\n`);
		b.stdin.end();
		expect(await b.done).toBe(0);
	});
});
