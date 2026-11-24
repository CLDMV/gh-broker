/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/connect.ts
 *	@Date: 2026-11-22T00:00:00-08:00 (1795334400)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-22T22:38:51-08:00 (1795415931)
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

/** The most client traffic held while the socket is down, in string characters (a safety valve; a single line over it is held alone). */
export const HELD_MAX_CHARS = 1024 * 1024;

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
	// The partial line each side is assembling, as chunks: only the new chunk is searched for a
	// newline (a newline can't straddle chunks, and earlier chunks had none), so a multi-megabyte
	// line stays linear instead of rescanning a growing buffer on every chunk.
	let clientPieces: string[] = [];
	let serverPieces: string[] = [];
	/** Whether the current connection has produced a server chunk: only then does it reset the backoff. */
	let sawLine = false;
	/** The client's first initialize request line, and the notifications/initialized line after it. */
	let initLine: string | null = null;
	let initializedLine: string | null = null;
	/** Whether that initialize was actually written to a server: only then does a later connection replay it. */
	let initSent = false;
	/** Set when a disconnect left the client's initialize unanswered: the next replay forwards its answer instead of swallowing it. */
	let pendingInitAnswer = false;
	/** A replay in progress: waiting for the new socket's response to the initialize id. */
	let replay: { id: unknown; promise: Promise<string | null>; resolve: (line: string | null) => void } | null = null;
	/** Server lines that arrived while a replay was pending; forwarded after it completes. */
	let replayQueue: string[] = [];
	/** Client request ids sent to the server and not yet answered; errored on disconnect. */
	const inFlight = new Set<unknown>();
	/** Client lines that arrived while the socket was down; forwarded on the next connection. */
	let held: Array<{ line: string; id?: unknown }> = [];
	/** Total characters currently held (see HELD_MAX_CHARS). */
	let heldChars = 0;
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

	/** Remove one held entry, keeping the character count right. */
	const dropHeld = (entry: { line: string; id?: unknown }): void => {
		held = held.filter((h) => h !== entry);
		heldChars -= entry.line.length;
	};

	/** A request held while down gets -32000 once it has waited holdMs, connected or not. */
	const holdExpires = (entry: { line: string; id?: unknown }): void => {
		void (async () => {
			await d.sleep(holdMs);
			if (eof || !held.includes(entry)) return;
			dropHeld(entry);
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
		// A ceiling keeps a client that queues megabytes while the broker is down from pinning them
		// in memory forever: the oldest held lines are dropped (a request gets its -32000 at once,
		// so nothing hangs waiting for it), with one log line for the overflow event.
		let dropped = 0;
		while (held.length > 0 && heldChars + line.length > HELD_MAX_CHARS) {
			const oldest = held.shift()!;
			heldChars -= oldest.line.length;
			dropped++;
			if (oldest.id !== undefined) staleError(oldest.id);
		}
		if (dropped > 0) d.log(`bridge: held queue over the ${HELD_MAX_CHARS}-char ceiling; dropped ${dropped} line(s)`);
		held.push(entry);
		heldChars += line.length;
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
		if (isRequest(parsed)) {
			inFlight.add(parsed.id);
			// the initialize has reached a server: only now may a later connection replay it
			if (parsed.method === "initialize") initSent = true;
		}
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
		heldChars = 0;
		for (const h of q) deliverClientLine(h.line);
	};

	/**
	 * Wait out the replay (at most holdMs), then resume both directions. The replayed initialize's
	 * response is swallowed — unless the client's own initialize never got its answer because the
	 * socket closed first (pendingInitAnswer): then the replay's answer IS the client's answer and
	 * is forwarded instead. list_changed goes only on the swallow path: in the pendingInitAnswer
	 * arm the client has listed nothing yet.
	 */
	const startReplay = (sock: Socket): void => {
		if (initLine === null) return;
		sock.write(`${initLine}\n`);
		if (initializedLine !== null) sock.write(`${initializedLine}\n`);
		let resolve!: (line: string | null) => void;
		const promise = new Promise<string | null>((r) => (resolve = r));
		const w = { id: tryParse(initLine)?.id, promise, resolve };
		replay = w;
		void (async () => {
			// The server may never answer (a half-started daemon): the wait times out, one line is
			// logged and the socket is dropped, so the close handler re-dials and the next
			// connection replays again.
			const timedOut = { timedOut: true as const };
			const outcome: { line: string | null } | typeof timedOut = await Promise.race([
				promise.then((line: string | null) => ({ line })),
				d.sleep(holdMs).then((): typeof timedOut => timedOut)
			]);
			if (replay === w) replay = null;
			if ("timedOut" in outcome) {
				d.log(`bridge: no initialize response in ${holdMs}ms; retrying`);
				sock.destroy();
				return;
			}
			const responseLine = outcome.line;
			// null: the socket closed mid-replay — the close handler has taken over and the next
			// connection replays again; no list_changed, nothing forwarded.
			if (responseLine === null) return;
			if (pendingInitAnswer) {
				// The answer is the client's own initialize's: forward it and then the held lines.
				// No list_changed here: the client has not listed anything yet (it only sends
				// notifications/initialized after this answer, and that answer is never held).
				pendingInitAnswer = false;
				deliverServerLine(responseLine);
				flushHeld();
			} else {
				writeToClient(LIST_CHANGED);
				flushHeld();
			}
			const queued = replayQueue;
			replayQueue = [];
			for (const line of queued) if (line !== responseLine) deliverServerLine(line); // the swallowed one stays swallowed
		})();
	};

	const onData = (chunk: string): void => {
		// the socket is setEncoding("utf8") in onConnected, so a multi-byte character split across
		// reads decodes correctly here and the line stays byte-identical for the client
		// A connection that says nothing doesn't prove the broker is back: the backoff resets on the
		// connection's first chunk, so an accept-and-close loop keeps backing off instead of
		// re-dialing every startMs forever.
		if (!sawLine) {
			sawLine = true;
			backoff = startMs;
		}
		let at = 0; // everything before this in the chunk is already cut into lines
		for (;;) {
			const nl = chunk.indexOf("\n", at);
			if (nl < 0) break;
			serverPieces.push(chunk.slice(at, nl));
			const line = serverPieces.join("");
			serverPieces = [];
			onSocketLine(line);
			at = nl + 1;
		}
		if (at < chunk.length) serverPieces.push(chunk.slice(at));
	};

	const onSocketClosed = (): void => {
		socket = null;
		serverPieces = [];
		replayQueue = [];
		if (replay !== null) replay.resolve(null);
		if (eof) return; // stdin already ended: nothing to tell the client, no retry
		// If the client's initialize is still unanswered, the next replay will carry its answer:
		// keep the client waiting for that one instead of failing it, and error everything else.
		// The kept answer expires like any other request: if no replay has delivered it holdMs
		// from now, the client gets its -32000 instead of waiting forever.
		const initId = initLine === null ? undefined : tryParse(initLine)?.id;
		if (initId !== undefined && inFlight.has(initId)) {
			pendingInitAnswer = true;
			inFlight.delete(initId);
			void (async () => {
				await d.sleep(holdMs);
				if (eof || !pendingInitAnswer) return;
				pendingInitAnswer = false;
				staleError(initId);
			})();
		}
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
		serverPieces = [];
		sawLine = false; // the backoff resets on the connection's first chunk, not on the accept
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
		// recorded one and swallows its response, so the client sees its initialize answer once —
		// but only an initialize that actually reached a server: one still held from a connection
		// that died early is forwarded fresh instead (no replay, no swallow, no list_changed yet).
		if (!first && initSent) startReplay(sock);
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
		if (clientPieces.length > 0) deliverClientLine(clientPieces.join("")); // a partial last line still counts
		clientPieces = [];
		const sock = socket;
		socket = null;
		if (sock !== null) sock.destroy();
		clearInterval(keepAlive);
		inFlight.clear();
		held = [];
		heldChars = 0;
		resolveDone(0);
	};

	d.stdin.setEncoding("utf8");
	d.stdin.on("data", (chunk) => {
		let at = 0; // everything before this in the chunk is already cut into lines
		for (;;) {
			const nl = chunk.indexOf("\n", at);
			if (nl < 0) break;
			clientPieces.push(chunk.slice(at, nl));
			const line = clientPieces.join("");
			clientPieces = [];
			deliverClientLine(line);
			at = nl + 1;
		}
		if (at < chunk.length) clientPieces.push(chunk.slice(at));
	});
	d.stdin.on("end", onEof);
	// A dead stdin (EIO, ECONNRESET) ends the bridge the same way a closed one does; without this
	// the error would crash the process with a stack trace.
	d.stdin.on("error", onEof);
	// The client vanishing without an EOF must not take the bridge down with an unhandled error;
	// its stdin closing ends the bridge normally.
	d.stdout.on("error", () => {});
	dial();
	return done;
}
