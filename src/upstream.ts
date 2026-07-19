import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./types.ts";
import type { Upstream } from "./router.ts";

const CLIENT_INFO = { name: "cldmv-gh-broker", version: "0.1.0" };

/**
 * Pool of MCP client connections to the hosted GitHub MCP — one per bearer token,
 * so each org's PAT drives its own upstream session. Connections are created lazily
 * and reused; the PAT is only ever set as an `Authorization: Bearer` header and is
 * never logged.
 */
export class UpstreamPool implements Upstream {
	private readonly url: URL;
	private readonly clients = new Map<string, Promise<Client>>();

	constructor(config: Config) {
		this.url = new URL(config.upstream);
	}

	private connect(token: string): Promise<Client> {
		const existing = this.clients.get(token);
		if (existing) return existing;
		const pending = (async (): Promise<Client> => {
			const client = new Client(CLIENT_INFO);
			const transport = new StreamableHTTPClientTransport(this.url, {
				requestInit: { headers: { Authorization: `Bearer ${token}` } }
			});
			await client.connect(transport);
			return client;
		})();
		// Don't cache a failed connect — let the next call retry.
		pending.catch(() => this.clients.delete(token));
		this.clients.set(token, pending);
		return pending;
	}

	async forward(tool: string, args: Record<string, unknown>, token: string): Promise<CallToolResult> {
		const client = await this.connect(token);
		try {
			return (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
		} catch (err) {
			// The cached session can go stale server-side (e.g. upstream idle-session
			// expiry) even though connect() succeeded — evict it so the *next* call
			// gets a fresh connection instead of repeating this failure until the
			// whole broker process is restarted.
			this.clients.delete(token);
			throw err;
		}
	}

	/** Fetch upstream tool schemas (owner-independent) to build the advertised catalog. */
	async listToolsFor(token: string): Promise<Tool[]> {
		const client = await this.connect(token);
		try {
			const res = await client.listTools();
			return res.tools;
		} catch (err) {
			this.clients.delete(token);
			throw err;
		}
	}
}
