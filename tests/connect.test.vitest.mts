import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONNECT_HELP, HELD_MAX_CHARS, runBridge, type ConnectDeps } from "../src/cli/connect.ts";

// The bridge against a real Unix socket: a small line-framed fake broker (it answers initialize,
// echoes everything else back, and can be told to kick the connection or refuse dials), driven
// through a PassThrough stdin with the client's stdout collected. The injected sleep records what
// it was asked for and really waits, with small backoff/hold overrides so the restart tests are fast.

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Poll until `what` holds, so the tests assert on outcomes rather than sleeping through timings. */
async function waitFor(what: () => boolean, ms = 10_000): Promise<void> {
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
	private sockets = new Set<Socket>();
	readonly received: string[] = [];
	connections = 0;
	/** How many initialize answers this fake has sent (so tests can assert after the last one). */
	initializeAnswers = 0;
	/** Answer an initialize request with a result response (everything else is echoed verbatim). */
	answerInitialize = true;
	/** Echo non-initialize lines back. */
	echo = true;
	/** Called with each new connection, after it is recorded. */
	onConnection: ((sock: Socket) => void) | null = null;

	constructor(readonly path: string) {}

	/** Connections the bridge currently holds open. */
	activeSockets(): number {
		return this.sockets.size;
	}

	async start(): Promise<void> {
		const server = createServer((sock) => {
			this.connections++;
			this.sockets.add(sock);
			sock.setEncoding("utf8");
			// framed like the bridge: chunks collected, only the new chunk searched, joined per line —
			// a multi-megabyte line must not make the FAKE the quadratic thing under test
			let pieces: string[] = []; // per connection: a partial line from a dropped one must not join the next
			sock.on("data", (chunk: string) => {
				let at = 0; // everything before this in the chunk is already cut into lines
				for (;;) {
					const nl = chunk.indexOf("\n", at);
					if (nl < 0) break;
					pieces.push(chunk.slice(at, nl));
					const line = pieces.join("");
					pieces = [];
					this.onLine(line, sock);
					at = nl + 1;
				}
				if (at < chunk.length) pieces.push(chunk.slice(at));
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
			this.initializeAnswers++;
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

	/** Write raw bytes to the bridge (to split a multi-byte character across socket reads). */
	writeRaw(data: Buffer): void {
		for (const s of this.sockets) s.write(data);
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

	waitNext(pred: (l: string) => boolean, ms = 10_000): Promise<string> {
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

	it("decodes a multi-byte character split across socket reads byte for byte", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path);
		await waitFor(() => broker.connections === 1);
		const line = JSON.stringify({ jsonrpc: "2.0", id: 4, result: { note: "文字✻" } });
		const bytes = Buffer.from(`${line}\n`, "utf8");
		const cut = Buffer.byteLength(line.slice(0, line.indexOf("文")), "utf8") + 1; // mid-character
		broker.writeRaw(bytes.subarray(0, cut));
		broker.writeRaw(bytes.subarray(cut));
		// the client sees the exact original text, not a re-serialization
		expect(await b.client.waitNext((l) => l === line)).toBe(line);
	});

	it("moves a multi-megabyte line in both directions in bounded time", async () => {
		const broker = await startBroker(nextSock());
		broker.echo = false;
		const b = startBridge(broker.path);
		await waitFor(() => broker.connections === 1);
		const line = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "x", params: { blob: "a".repeat(10_000_000) } });
		// client → server, in many small chunks: the bridge must stay linear in the line's size
		let start = Date.now();
		for (let i = 0; i < line.length; i += 16_000) b.stdin.write(line.slice(i, i + 16_000));
		b.stdin.write("\n");
		await waitFor(() => broker.received[0] === line);
		expect(Date.now() - start).toBeLessThan(2000);
		// server → client, also in many small chunks
		const bytes = Buffer.from(`${line}\n`, "utf8");
		start = Date.now();
		for (let i = 0; i < bytes.length; i += 16_000) broker.writeRaw(bytes.subarray(i, i + 16_000));
		expect(await b.client.waitNext((l) => l === line)).toBe(line);
		expect(Date.now() - start).toBeLessThan(2000);
	});

	it("flushes a partial last line on stdin EOF and exits 0 with the socket closed", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path);
		await waitFor(() => broker.connections === 1);
		b.stdin.write('{"jsonrpc":"2.0","id":5,"method":"to');
		b.stdin.end();
		await waitFor(() => broker.received[0] === '{"jsonrpc":"2.0","id":5,"method":"to');
		expect(await b.done).toBe(0);
		await waitFor(() => broker.activeSockets() === 0);
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
		await b.client.waitNext((l) => l === req(2, "tools/list")); // echoed back to the client
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

	it("holds a request sent during the replay wait and forwards it after the replay completes", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path, { holdMs: 5000 }); // no expiry can race this test
		await waitFor(() => broker.connections === 1);
		b.stdin.write(`${initReq(1)}\n${initNotify()}\n`);
		await b.client.waitNext(isResponse(1));
		broker.answerInitialize = false; // the replayed initialize gets no answer: the wait stays open
		broker.kick();
		await waitFor(() => broker.received.filter((l) => l === initReq(1)).length >= 2); // replay sent, pending
		b.stdin.write(`${req(8)}\n`); // arrives during the replay wait: held, not forwarded
		await realSleep(50);
		expect(broker.received.some((l) => l === req(8))).toBe(false);
		broker.respond(1, { resumed: true }); // the replay's initialize answer arrives: the wait ends
		await b.client.waitNext(isListChanged);
		await b.client.waitNext((l) => l === req(8)); // the held request goes out after the replay
		expect(broker.received.indexOf(req(8))).toBeGreaterThan(broker.received.lastIndexOf(initReq(1)));
		expect(b.client.lines.filter(isResponse(1))).toHaveLength(1); // that answer was swallowed
		expect(b.client.lines.filter(isStale(8))).toHaveLength(0); // and the request was never errored
	});

	it("replays only the initialize when the socket died before notifications/initialized was seen", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path);
		await waitFor(() => broker.connections === 1);
		b.stdin.write(`${initReq(1)}\n`); // the client never gets to notifications/initialized
		await b.client.waitNext(isResponse(1));
		broker.kick();
		await b.client.waitNext(isListChanged);
		expect(broker.received.filter((l) => l === initReq(1))).toHaveLength(2); // initialize replayed
		expect(broker.received.filter((l) => l === initNotify())).toHaveLength(0); // nothing to replay for it
		expect(b.client.lines.filter(isResponse(1))).toHaveLength(1); // the replayed answer stays swallowed
	});

	it("times the replay wait out, drops the socket, and completes on a later connection", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path, { holdMs: 40 });
		await waitFor(() => broker.connections === 1);
		b.stdin.write(`${initReq(1)}\n${initNotify()}\n`);
		await b.client.waitNext(isResponse(1));
		broker.answerInitialize = false; // the replayed initialize is accepted but never answered
		broker.kick();
		await waitFor(() => broker.received.filter((l) => l === initReq(1)).length >= 2);
		await waitFor(() => b.logs.some((l) => l === "bridge: no initialize response in 40ms; retrying"));
		broker.answerInitialize = true; // the next connection answers: the flow completes
		await waitFor(() => broker.connections >= 3);
		await b.client.waitNext(isListChanged);
		expect(b.client.lines.filter(isResponse(1))).toHaveLength(1); // still exactly the first answer
	});

	it("delivers the replayed initialize's answer when the client's own never got one", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path, { holdMs: 5000 }); // no expiry can race this test
		await waitFor(() => broker.connections === 1);
		broker.answerInitialize = false; // the client's initialize stays unanswered
		b.stdin.write(`${initReq(1)}\n`);
		await waitFor(() => broker.received.some((l) => l === initReq(1)));
		broker.kick(); // the initialize is in flight: the client must not get -32000 for it
		broker.answerInitialize = true; // the next connection's replay carries the answer
		await b.client.waitNext(isResponse(1)); // the replay's answer IS the client's answer
		expect(b.client.lines.filter(isStale(1))).toHaveLength(0);
		expect(broker.received.filter((l) => l === initReq(1))).toHaveLength(2);
		// and no list_changed at all in this path: the client has listed nothing yet
		expect(b.client.lines.filter(isListChanged)).toHaveLength(0);
	});

	it("expires a pending initialize answer across a replay timeout instead of waiting forever", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path, { holdMs: 40 });
		await waitFor(() => broker.connections === 1);
		broker.answerInitialize = false; // the client's initialize is never answered in time
		b.stdin.write(`${initReq(1)}\n`);
		await waitFor(() => broker.received.some((l) => l === initReq(1)));
		broker.kick(); // the initialize is in flight at close: pendingInitAnswer is set, expiry scheduled
		// The expiry (scheduled at the close) fires before the replay's own timeout, so the client
		// gets its -32000 and stops waiting — the kept answer never outlives holdMs.
		const stale = await b.client.waitNext(isStale(1), 2000);
		expect(JSON.parse(stale)).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "gh-broker restarted; retry" } });
		await waitFor(() => b.logs.some((l) => l === "bridge: no initialize response in 40ms; retrying")); // the replay still timed out
		// a later answering connection replays again — and now swallows: the client has been told
		// to retry, so it gets no answer for an id it gave up on, and no second -32000. Asserted
		// only once the fake has actually SENT that replay answer (not on a timer).
		broker.answerInitialize = true;
		await waitFor(() => broker.connections >= 3);
		await waitFor(() => broker.initializeAnswers >= 1);
		await realSleep(20);
		expect(b.client.lines.filter(isResponse(1))).toHaveLength(0);
		expect(b.client.lines.filter(isStale(1))).toHaveLength(1);
	});

	it("does not replay an initialize it never wrote to a socket", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path, { backoffStartMs: 150, backoffMaxMs: 300, holdMs: 5000 }); // no expiry can race this test
		await waitFor(() => broker.connections === 1);
		broker.kick(); // the first connection drops before the client says anything
		await waitFor(() => b.logs.some((l) => l.startsWith("bridge: socket closed")));
		b.stdin.write(`${initReq(1)}\n${initNotify()}\n`); // held: never written to a socket
		// the next connection forwards the held handshake live: the client gets its answer with no
		// replay, no swallow, and no list_changed ahead of the handshake
		await b.client.waitNext(isResponse(1));
		expect(b.client.lines[0]).toContain('"result"');
		expect(b.client.lines.filter(isListChanged)).toHaveLength(0);
		expect(broker.received.filter((l) => l === initReq(1))).toHaveLength(1);
		expect(broker.received.filter((l) => l === initNotify())).toHaveLength(1);
	});

	it("expires the pending initialize answer when no replay delivers it", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path, { holdMs: 40 });
		await waitFor(() => broker.connections === 1);
		broker.answerInitialize = false;
		b.stdin.write(`${initReq(1)}\n`);
		await waitFor(() => broker.received.some((l) => l === initReq(1)));
		broker.kick();
		await broker.stop(); // no reconnect: the kept answer must still expire like any held request
		const stale = await b.client.waitNext(isStale(1), 2000);
		expect(JSON.parse(stale)).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "gh-broker restarted; retry" } });
	});

	it("exits 0 on stdin EOF during the replay wait", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path);
		await waitFor(() => broker.connections === 1);
		b.stdin.write(`${initReq(1)}\n${initNotify()}\n`);
		await b.client.waitNext(isResponse(1));
		broker.answerInitialize = false; // the replay wait stays open
		broker.kick();
		await waitFor(() => broker.received.filter((l) => l === initReq(1)).length >= 2);
		b.stdin.end();
		expect(await b.done).toBe(0); // no hang waiting for the answer
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

	it("caps the held queue, dropping the oldest line when it overflows", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path, { backoffStartMs: 150, backoffMaxMs: 300 });
		await waitFor(() => broker.connections === 1);
		b.stdin.write(`${initReq(1)}\n`);
		await b.client.waitNext(isResponse(1));
		broker.kick();
		await waitFor(() => b.logs.some((l) => l.startsWith("bridge: socket closed")));
		const pad = (n: number) => JSON.stringify({ jsonrpc: "2.0", method: `n${n}`, params: { pad: "x".repeat(300_000) } });
		for (const n of [1, 2, 3, 4]) b.stdin.write(`${pad(n)}\n`); // ~1.2 MB held: the ceiling drops the oldest
		await waitFor(() => b.logs.some((l) => l.includes("held queue over the 1048576-char ceiling")));
		expect(b.logs.filter((l) => l.includes("held queue over"))).toHaveLength(1); // one summary line per overflow event
		expect(b.logs.some((l) => l.includes("dropped 1 line(s)"))).toBe(true);
		// reconnect: the survivors are forwarded, the dropped one is not, and the bridge still works
		await b.client.waitNext(isListChanged);
		await waitFor(() => broker.received.some((l) => l.includes('"n4"')));
		expect(broker.received.some((l) => l.includes('"n1"'))).toBe(false);
		for (const n of [2, 3]) expect(broker.received.some((l) => l.includes(`"n${n}"`))).toBe(true);
		b.stdin.write(`${req(2, "tools/list")}\n`);
		await b.client.waitNext((l) => l === req(2, "tools/list")); // still functioning
	});

	it("errors a held request that the ceiling drops", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path, { backoffStartMs: 150, backoffMaxMs: 300, holdMs: 5000 }); // no expiry can race this test
		await waitFor(() => broker.connections === 1);
		b.stdin.write(`${initReq(1)}\n`);
		await b.client.waitNext(isResponse(1));
		broker.kick();
		await waitFor(() => b.logs.some((l) => l.startsWith("bridge: socket closed")));
		b.stdin.write(`${req(5)}\n${req(6)}\n`); // two small held requests
		const padLine = (n: number) => JSON.stringify({ jsonrpc: "2.0", method: "big", params: { pad: "x".repeat(n) } });
		// over the ceiling with both requests held, under it once the oldest (a request) is dropped
		const big = padLine(HELD_MAX_CHARS - 88 - padLine(0).length);
		b.stdin.write(`${big}\n`);
		const stale = await b.client.waitNext(isStale(5), 2000);
		expect(JSON.parse(stale)).toEqual({ jsonrpc: "2.0", id: 5, error: { code: -32000, message: "gh-broker restarted; retry" } });
		// the survivors are forwarded on reconnect and nothing else was errored
		await b.client.waitNext(isListChanged);
		await waitFor(() => broker.received.some((l) => l === req(6)) && broker.received.some((l) => l === big));
		expect(b.client.lines.filter(isStale(6))).toHaveLength(0);
	});

	it("drops several held lines in one overflow event behind a single summary", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path, { backoffStartMs: 150, backoffMaxMs: 300, holdMs: 5000 }); // no expiry can race this test
		await waitFor(() => broker.connections === 1);
		b.stdin.write(`${initReq(1)}\n`);
		await b.client.waitNext(isResponse(1));
		broker.kick();
		await waitFor(() => b.logs.some((l) => l.startsWith("bridge: socket closed")));
		const pad = (n: number) => JSON.stringify({ jsonrpc: "2.0", method: `n${n}`, params: { pad: "x".repeat(300_000) } });
		b.stdin.write(`${pad(1)}\n${pad(2)}\n`); // two ~300KB notifications held
		const big = JSON.stringify({ jsonrpc: "2.0", method: "big", params: { pad: "x".repeat(900_000) } });
		b.stdin.write(`${big}\n`); // ~1.5MB total: both held lines drop in this one overflow event
		await waitFor(() => b.logs.some((l) => l.includes("dropped 2 line(s)")));
		expect(b.logs.filter((l) => l.includes("held queue over"))).toHaveLength(1); // one summary for the whole event
		// reconnect: only the line that fit survives
		await b.client.waitNext(isListChanged);
		await waitFor(() => broker.received.some((l) => l === big));
		expect(broker.received.some((l) => l.includes('"n1"'))).toBe(false);
		expect(broker.received.some((l) => l.includes('"n2"'))).toBe(false);
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

	it("doubles the backoff, caps it, and resets it once a connection has spoken", async () => {
		const path = nextSock();
		const b = startBridge(path, { backoffStartMs: 5, backoffMaxMs: 12 });
		await waitFor(() => b.sleeps.length >= 3);
		expect(b.sleeps.slice(0, 3)).toEqual([5, 10, 12]);
		const broker = await startBroker(path);
		await waitFor(() => broker.connections === 1);
		// a connection that says nothing does not reset the backoff: kick it untouched and the
		// retry continues from where the failures left off
		const untouched = b.sleeps.length;
		broker.kick();
		await waitFor(() => b.sleeps.length > untouched);
		expect(b.sleeps[untouched]).toBe(12);
		// once the connection has produced a server line, the next restart starts over
		b.stdin.write(`${req(1)}\n`); // its echo is the connection's first server line
		await b.client.waitNext((l) => l === req(1));
		const before = b.sleeps.length;
		broker.kick();
		await waitFor(() => b.sleeps.length > before);
		expect(b.sleeps[before]).toBe(5); // the restart's first retry is back at the start
	});

	it("keeps backing off when the broker accepts and closes without saying anything", async () => {
		const path = nextSock();
		const broker = new FakeBroker(path);
		broker.onConnection = (sock) => sock.destroy(); // accept-and-immediate-close, forever
		await broker.start();
		brokers.push(broker);
		const b = startBridge(path, { backoffStartMs: 5, backoffMaxMs: 20 });
		await waitFor(() => b.sleeps.length >= 3);
		expect(b.sleeps.slice(0, 3)).toEqual([5, 10, 20]); // grows to the cap, never stuck at the start
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
		await waitFor(() => broker.activeSockets() === 0); // the late socket was destroyed, not adopted
	});
});

describe("client stream edges", () => {
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

	it("treats a stdin error like an EOF and exits 0", async () => {
		const broker = await startBroker(nextSock());
		const b = startBridge(broker.path);
		await waitFor(() => broker.connections === 1);
		b.stdin.emit("error", new Error("EIO"));
		expect(await b.done).toBe(0);
		await waitFor(() => broker.activeSockets() === 0);
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
