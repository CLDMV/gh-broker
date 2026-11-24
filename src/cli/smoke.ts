/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/smoke.ts
 *	@Date: 2026-09-06T10:05:35-07:00 (1788714335)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-23T19:39:25-08:00 (1795491565)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { connect, type Socket } from "node:net";

/** A JSON-RPC response as the broker sends it. */
interface RpcMessage {
	id?: number | null;
	error?: { message?: string };
	result?: unknown;
}

/** What the smoke test reports. */
export interface SmokeResult {
	tools: string[];
	roundTrip: string | null;
}

/**
 * Post-deploy smoke test: connect to the broker's Unix socket, do the MCP
 * handshake, list tools, and — if a safe owner-less read (`get_me`) is
 * advertised — make one real call so a GitHub round-trip is actually exercised.
 * Resolves with { tools, roundTrip } or rejects with a clear reason.
 *
 * The daemon does a network `buildCatalog` before it creates the socket, and
 * `systemctl restart` returns as soon as the process spawns — so the socket may
 * not exist yet. We therefore RETRY the connection (ENOENT/ECONNREFUSED) until
 * the deadline rather than failing on the first attempt.
 *
 * The broker speaks newline-delimited JSON-RPC (MCP stdio framing) over the
 * socket, so this needs no dependency — raw net + JSON lines.
 */
function connectWithRetry(socketPath: string, deadline: number): Promise<Socket> {
	return new Promise<Socket>((resolve, reject) => {
		const attempt = (): void => {
			const sock = connect(socketPath);
			let settled = false;
			sock.once("connect", () => {
				settled = true;
				resolve(sock);
			});
			sock.once("error", (e: NodeJS.ErrnoException) => {
				if (settled) return;
				sock.destroy();
				if (Date.now() < deadline && (e.code === "ENOENT" || e.code === "ECONNREFUSED")) {
					setTimeout(attempt, 250);
				} else {
					reject(new Error(`smoke: socket error (${socketPath}): ${e.message}`));
				}
			});
		};
		attempt();
	});
}

function handshake(sock: Socket, deadline: number): Promise<SmokeResult> {
	return new Promise<SmokeResult>((resolve, reject) => {
		let idc = 0;
		const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
		const timer = setTimeout(
			() => {
				cleanup();
				reject(new Error(`smoke: no response before deadline`));
			},
			Math.max(1000, deadline - Date.now())
		);

		const cleanup = (): void => {
			clearTimeout(timer);
			sock.destroy();
		};
		const send = (method: string, params: unknown): Promise<unknown> =>
			new Promise<unknown>((res, rej) => {
				const id = ++idc;
				pending.set(id, { res, rej });
				sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
			});
		const notify = (method: string): boolean => sock.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");

		sock.on("error", (e) => {
			cleanup();
			reject(new Error(`smoke: socket error: ${e.message}`));
		});
		// Chunks arrive as strings (setEncoding, as the connect bridge does): a multi-byte character
		// split across reads decodes correctly and the line stays byte-identical.
		sock.setEncoding("utf8");
		// The partial line is an array of chunks: only the new chunk is searched for a newline (a
		// newline can't straddle chunks, and earlier chunks had none), so framing stays linear
		// instead of rescanning a growing buffer on every chunk (the pattern #193 removed from the
		// bridge).
		let pieces: string[] = [];
		/** Dispatch one complete line: blank and unparseable ones are ignored, answers settle their senders. */
		const onLine = (line: string): void => {
			if (!line.trim()) return;
			let msg: RpcMessage;
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			if (msg.id != null && pending.has(msg.id)) {
				const { res, rej } = pending.get(msg.id)!;
				pending.delete(msg.id);
				if (msg.error) rej(new Error(msg.error.message || "rpc error"));
				else res(msg.result);
			}
		};
		sock.on("data", (chunk: string) => {
			let at = 0; // everything before this in the chunk is already cut into lines
			for (;;) {
				const nl = chunk.indexOf("\n", at);
				if (nl < 0) break;
				pieces.push(chunk.slice(at, nl));
				const line = pieces.join("");
				pieces = [];
				onLine(line);
				at = nl + 1;
			}
			if (at < chunk.length) pieces.push(chunk.slice(at));
		});

		void (async () => {
			try {
				await send("initialize", {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "gh-broker-smoke", version: "1.0" }
				});
				notify("notifications/initialized");
				const listed = (await send("tools/list", {})) as { tools?: { name: string }[] } | undefined;
				const tools = (listed?.tools ?? []).map((t) => t.name);

				let roundTrip: string | null = null;
				if (tools.includes("get_me")) {
					try {
						const out = (await send("tools/call", { name: "get_me", arguments: {} })) as { isError?: boolean } | undefined;
						roundTrip = out?.isError ? "get_me returned an error" : "get_me ok";
					} catch (e) {
						roundTrip = `get_me failed: ${(e as Error).message}`;
					}
				}
				cleanup();
				resolve({ tools, roundTrip });
			} catch (e) {
				cleanup();
				reject(e);
			}
		})();
	});
}

export async function smokeTest(socketPath: string, { timeoutMs = 15000 }: { timeoutMs?: number } = {}): Promise<SmokeResult> {
	const deadline = Date.now() + timeoutMs;
	const sock = await connectWithRetry(socketPath, deadline);
	return handshake(sock, deadline);
}
