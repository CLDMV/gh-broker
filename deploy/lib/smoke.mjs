import { connect } from "node:net";

/**
 * Post-deploy smoke test: connect to the broker's Unix socket, do the MCP
 * handshake, list tools, and — if a safe owner-less read (`get_me`) is
 * advertised — make one real call so a GitHub round-trip is actually exercised.
 * Resolves with { tools, roundTrip } or rejects with a clear reason.
 *
 * The broker speaks newline-delimited JSON-RPC (MCP stdio framing) over the
 * socket, so this needs no dependency — raw net + JSON lines.
 */
export function smokeTest(socketPath, { timeoutMs = 8000 } = {}) {
	return new Promise((resolve, reject) => {
		const sock = connect(socketPath);
		let buf = "";
		let idc = 0;
		const pending = new Map();
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`smoke: no response within ${timeoutMs}ms`));
		}, timeoutMs);

		const cleanup = () => {
			clearTimeout(timer);
			sock.destroy();
		};
		const send = (method, params) =>
			new Promise((res, rej) => {
				const id = ++idc;
				pending.set(id, { res, rej });
				sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
			});
		const notify = (method) => sock.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");

		sock.on("error", (e) => {
			cleanup();
			reject(new Error(`smoke: socket error (${socketPath}): ${e.message}`));
		});
		sock.on("data", (d) => {
			buf += d.toString("utf8");
			let nl;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (msg.id != null && pending.has(msg.id)) {
					const { res, rej } = pending.get(msg.id);
					pending.delete(msg.id);
					if (msg.error) rej(new Error(msg.error.message || "rpc error"));
					else res(msg.result);
				}
			}
		});
		sock.on("connect", async () => {
			try {
				await send("initialize", {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "gh-broker-smoke", version: "1.0" }
				});
				notify("notifications/initialized");
				const listed = await send("tools/list", {});
				const tools = (listed?.tools ?? []).map((t) => t.name);

				let roundTrip = null;
				if (tools.includes("get_me")) {
					try {
						const out = await send("tools/call", { name: "get_me", arguments: {} });
						roundTrip = out?.isError ? "get_me returned an error" : "get_me ok";
					} catch (e) {
						roundTrip = `get_me failed: ${e.message}`;
					}
				}
				cleanup();
				resolve({ tools, roundTrip });
			} catch (e) {
				cleanup();
				reject(e);
			}
		});
	});
}
