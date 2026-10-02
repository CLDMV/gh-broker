/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/upstream.ts
 *	@Date: 2026-07-07T00:24:51-07:00 (1783409091)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T11:30:58-07:00 (1790965858)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

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
		return this.withReconnect(token, (client) => client.callTool({ name: tool, arguments: args }) as Promise<CallToolResult>);
	}

	/** Fetch upstream tool schemas (owner-independent) to build the advertised catalog. */
	async listToolsFor(token: string): Promise<Tool[]> {
		return this.withReconnect(token, async (client) => (await client.listTools()).tools);
	}

	/**
	 * Run an upstream op with a single transparent reconnect. The hosted MCP's
	 * streamable-HTTP session can die server-side (idle-session expiry, upstream
	 * restart) even though our cached client still looks connected — the next call
	 * then fails with "invalid session". Rather than surface that first failure to
	 * the agent (and leave it stuck until the whole broker restarts), evict the dead
	 * client and retry ONCE with a fresh connection. A genuinely broken call (bad
	 * token, real upstream error) fails the retry too and propagates.
	 */
	private async withReconnect<T>(token: string, op: (client: Client) => Promise<T>): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			const client = await this.connect(token);
			try {
				return await op(client);
			} catch (err) {
				// Evict the (possibly stale) session so this retry / the next call reconnects.
				this.clients.delete(token);
				if (attempt >= 1) throw err;
			}
		}
	}
}
