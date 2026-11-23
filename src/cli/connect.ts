/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/connect.ts
 *	@Date: 2026-11-22T00:00:00-08:00 (1795334400)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-22T20:05:36-08:00 (1795406736)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * `gh-broker connect <socket>` (#193): the stdio bridge behind the broker's MCP entry — the
 * replacement for `socat STDIO UNIX-CONNECT:…`. It pipes newline-delimited JSON-RPC between the
 * client's stdin/stdout and the agent's broker socket, and it survives the broker restarting:
 * socat died with the socket and left the client's MCP server failed until a manual
 * `/mcp reconnect`; this one dials again with a backoff, replays the client's initialize
 * handshake to the new socket, swallows the duplicate response, and tells the client its tool
 * list may have changed. A request that was in flight when the socket closed, or that has been
 * held longer than holdMs while the socket is down, gets a -32000 error so the client can retry
 * instead of hanging. It exits only when the client's stdin closes; socket trouble never exits.
 * Every effect is injected (the real ones are in real-deps.ts), so the whole behavior runs
 * against a fake socket in tests.
 */
import type { Socket } from "node:net";

/** The effects the `connect` bridge uses. */
export interface ConnectDeps {
	/** The client's side: line-buffered by the bridge. */
	stdin: NodeJS.ReadableStream;
	/** The client's protocol side — log lines never go here (they go to stderr via `log`). */
	stdout: NodeJS.WritableStream;
	/** One line per disconnect / reconnect / dial failure; console.error in production. */
	log: (m: string) => void;
	/** Dial the socket. Rejects when it can't (ENOENT, ECONNREFUSED, …); the bridge retries. */
	connect: (path: string) => Promise<Socket>;
	/** An awaitable pause: the reconnect backoff and the hold timeout both run on it. */
	sleep: (ms: number) => Promise<void>;
	/** First reconnect delay, doubled per failure (default 250ms). */
	backoffStartMs?: number;
	/** Backoff cap (default 5000ms). */
	backoffMaxMs?: number;
	/** How long a request may sit held while the socket is down before it gets -32000 (default 30s). */
	holdMs?: number;
}

export const CONNECT_HELP = `connect <socket>

The stdio bridge the broker's MCP entry runs: it pipes stdin/stdout
JSON-RPC to <socket>, the agent's own broker socket, and keeps the client
working across broker restarts. <socket> is an absolute path. When the
socket closes (the broker restarted) it dials again with a backoff, replays
the client's initialize handshake to the new socket, swallows the duplicate
response, and tells the client its tool list may have changed. A request
that was in flight when the socket closed, or that has been held longer
than 30s while the socket is down, gets a -32000 error so the client can
retry. Exits 0 when stdin closes; socket trouble never exits it.`;

/** A parsed JSON-RPC message worth looking at (a request, a response, or a notification). */
type Rpc = { method?: unknown; id?: unknown };

/** Parse a protocol line; anything that doesn't parse stays opaque and is never rejected. */
const tryParse = (line: string): Rpc | undefined => {
	try {
		const v: unknown = JSON.parse(line);
		return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rpc) : undefined;
	} catch {
		return undefined;
	}
};

/** A client request: a method and an id (notifications have no id, responses no method). */
const isRequest = (m: Rpc | undefined): m is Rpc => m !== undefined && typeof m.method === "string" && m.id !== undefined;

/** A server response to the given request id (a server-to-client request has a method too — not this). */
const isResponseTo = (m: Rpc | undefined, id: unknown): boolean =>
	m !== undefined && m.method === undefined && m.id !== undefined && m.id === id;

/** Sent to the client after a reconnect, so it re-lists the tools the restarted broker may have changed. */
const LIST_CHANGED = '{"jsonrpc":"2.0","method":"notifications/tools/list_changed","params":{}}';

/**
 * Run the bridge for one `connect` invocation: `argv` is everything after `connect`.
 * @returns the exit code — 0 once the client's stdin closes, 2 for a usage error. It only
 * resolves then: while the client is alive the bridge keeps running, through any number of
 * disconnects.
 */
export async function runBridge(argv: string[], d: ConnectDeps): Promise<number> {
	const [socketPath, ...extra] = argv;
	if (socketPath === undefined || extra.length > 0 || !socketPath.startsWith("/")) {
		d.log(CONNECT_HELP);
		return 2;
	}
	const startMs = d.backoffStartMs ?? 250;
	const maxMs = d.backoffMaxMs ?? 5000;
	const holdMs = d.holdMs ?? 30_000;

	let backoff = startMs;
	let socket: Socket | null = null;
	let eof = false;
	let dialing = false;
	let everConnected = false;
	let clientBuf = "";
	let serverBuf = "";
	/** The client's first initialize request line, and the notifications/initialized line after it. */
	let initLine: string | null = null;
	let initializedLine: string | null = null;
	/** A replay in progress: waiting for the new socket's response to the initialize id. */
	let replay: { id: unknown; promise: Promise<string | null>; resolve: (line: string | null) => void } | null = null;
	/** Server lines that arrived while a replay was pending; forwarded after it completes. */
	let replayQueue: string[] = [];
	/** Client request ids sent to the server and not yet answered; errored on disconnect. */
	const inFlight = new Set<unknown>();
	/** Client lines that arrived while the socket was down; forwarded on the next connection. */
	let held: Array<{ line: string; id?: unknown }> = [];
	// Holds the event loop open while the bridge runs (a backoff sleep doesn't: see realConnectDeps);
	// cleared at EOF so the process exits as soon as the client is done.
	const keepAlive = setInterval(() => {}, 1 << 30);

	let resolveDone!: (code: number) => void;
	const done = new Promise<number>((resolve) => (resolveDone = resolve));

	const writeToClient = (line: string): void => {
		d.stdout.write(`${line}\n`);
	};

	/** The error a request gets when the socket it was sent into (or would be sent into) is gone. */
	const staleError = (id: unknown): void => {
		writeToClient(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "gh-broker restarted; retry" } }));
	};

	/** A request held while down gets -32000 once it has waited holdMs, connected or not. */
	const holdExpires = (entry: { line: string; id?: unknown }): void => {
		void (async () => {
			await d.sleep(holdMs);
			if (eof || !held.includes(entry)) return;
			held = held.filter((h) => h !== entry);
			staleError(entry.id);
		})();
	};

	/** Queue a line that arrived while the socket was down (or while a replay was pending). */
	const hold = (line: string, parsed: Rpc | undefined): void => {
		const entry: { line: string; id?: unknown } = { line };
		if (isRequest(parsed)) {
			entry.id = parsed.id;
			holdExpires(entry);
		}
		held.push(entry);
	};

	/** One line from the client: capture the handshake, forward it, or hold it. */
	const deliverClientLine = (line: string): void => {
		const parsed = tryParse(line);
		if (initLine === null && parsed !== undefined && parsed.method === "initialize" && parsed.id !== undefined) initLine = line;
		else if (initLine !== null && initializedLine === null && parsed !== undefined && parsed.method === "notifications/initialized")
			initializedLine = line;
		// Nothing is forwarded while a replay is pending — the handshake goes first (the design's
		// "then forward anything else"); such lines wait in `held` with the disconnected ones.
		if (socket === null || replay !== null) {
			hold(line, parsed);
			return;
		}
		socket.write(`${line}\n`);
		if (isRequest(parsed)) inFlight.add(parsed.id);
	};

	/** One line from the server: answer-tracking, then straight to the client. */
	const deliverServerLine = (line: string): void => {
		const parsed = tryParse(line);
		if (parsed !== undefined && parsed.method === undefined && parsed.id !== undefined) inFlight.delete(parsed.id);
		writeToClient(line);
	};

	const onSocketLine = (line: string): void => {
		if (replay !== null) {
			// During the replay wait every server line queues; the one that answers the replayed
			// initialize also ends the wait (finishReplay swallows it instead of forwarding it).
			replayQueue.push(line);
			if (isResponseTo(tryParse(line), replay.id)) replay.resolve(line);
			return;
		}
		deliverServerLine(line);
	};

	/** Forward everything held (expired requests get their -32000 instead). */
	const flushHeld = (): void => {
		const q = held;
		held = [];
		for (const h of q) deliverClientLine(h.line);
	};

	/** Wait out the replay, swallow the duplicate initialize response, then resume both directions. */
	const startReplay = (sock: Socket): void => {
		if (initLine === null) return;
		sock.write(`${initLine}\n`);
		if (initializedLine !== null) sock.write(`${initializedLine}\n`);
		let resolve!: (line: string | null) => void;
		const promise = new Promise<string | null>((r) => (resolve = r));
		const w = { id: tryParse(initLine)?.id, promise, resolve };
		replay = w;
		void (async () => {
			const responseLine = await promise;
			if (replay === w) replay = null;
			// null: the socket closed mid-replay — the close handler has taken over and the next
			// connection replays again; no list_changed, nothing forwarded.
			if (responseLine === null) return;
			writeToClient(LIST_CHANGED);
			flushHeld();
			const queued = replayQueue;
			replayQueue = [];
			for (const line of queued) if (line !== responseLine) deliverServerLine(line); // the swallowed one stays swallowed
		})();
	};

	const onData = (chunk: string): void => {
		// the socket is setEncoding("utf8") in onConnected, so a multi-byte character split across
		// reads decodes correctly here and the line stays byte-identical for the client
		serverBuf += chunk;
		for (let nl = serverBuf.indexOf("\n"); nl >= 0; nl = serverBuf.indexOf("\n")) {
			const line = serverBuf.slice(0, nl);
			serverBuf = serverBuf.slice(nl + 1);
			onSocketLine(line);
		}
	};

	const onSocketClosed = (): void => {
		socket = null;
		serverBuf = "";
		replayQueue = [];
		if (replay !== null) replay.resolve(null);
		if (eof) return; // stdin already ended: nothing to tell the client, no retry
		for (const id of inFlight) staleError(id);
		inFlight.clear();
		d.log(`bridge: socket closed; retrying in ${backoff}ms`);
		void scheduleRetry();
	};

	const onConnected = (sock: Socket): void => {
		if (eof) {
			sock.destroy();
			return;
		}
		socket = sock;
		serverBuf = "";
		backoff = startMs; // a fresh connection restarts the backoff
		sock.setEncoding("utf8"); // chunks arrive as strings, split multi-byte characters included
		sock.on("data", onData);
		sock.on("close", onSocketClosed);
		sock.on("error", () => {
			/* 'close' follows every socket error; the retry handles it */
		});
		const first = !everConnected;
		everConnected = true;
		d.log(`bridge: connected to ${socketPath}`);
		// The first connection forwards the client's live handshake; every later one replays the
		// recorded one and swallows its response, so the client sees its initialize answer once.
		if (!first && initLine !== null) startReplay(sock);
		if (replay === null) flushHeld();
	};

	const scheduleRetry = async (): Promise<void> => {
		const delay = backoff;
		await d.sleep(delay);
		if (eof || socket !== null || dialing) return;
		backoff = Math.min(delay * 2, maxMs);
		dial();
	};

	const dial = (): void => {
		if (eof || socket !== null || dialing) return;
		dialing = true;
		void d.connect(socketPath).then(
			(sock) => {
				dialing = false;
				onConnected(sock);
			},
			() => {
				dialing = false;
				d.log(`bridge: cannot connect to ${socketPath}; retrying in ${backoff}ms`);
				void scheduleRetry();
			}
		);
	};

	const onEof = (): void => {
		if (eof) return;
		eof = true;
		if (clientBuf !== "") deliverClientLine(clientBuf); // a partial last line still counts
		clientBuf = "";
		const sock = socket;
		socket = null;
		if (sock !== null) sock.destroy();
		clearInterval(keepAlive);
		inFlight.clear();
		held = [];
		resolveDone(0);
	};

	d.stdin.setEncoding("utf8");
	d.stdin.on("data", (chunk) => {
		clientBuf += typeof chunk === "string" ? chunk : String(chunk);
		for (let nl = clientBuf.indexOf("\n"); nl >= 0; nl = clientBuf.indexOf("\n")) {
			const line = clientBuf.slice(0, nl);
			clientBuf = clientBuf.slice(nl + 1);
			deliverClientLine(line);
		}
	});
	d.stdin.on("end", onEof);
	// The client vanishing without an EOF must not take the bridge down with an unhandled error;
	// its stdin closing ends the bridge normally.
	d.stdout.on("error", () => {});
	dial();
	return done;
}
