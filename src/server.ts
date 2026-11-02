/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/server.ts
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

import { createServer, type Socket } from "node:net";
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./types.ts";
import type { Router } from "./router.ts";
import { agentsDir, parseAgentGroups, type Agent } from "./agents.ts";

const SERVER_INFO = { name: "gh-broker", version: "0.1.0" };

export interface ServerOptions {
	/** The group database to read agents from. Defaults to /etc/group. */
	groupFile?: string;
}

/**
 * Each agent connection (a socat stdio bridge to that agent's own socket) gets its own MCP
 * Server over a StdioServerTransport bound to that socket. `tools/list` returns the pre-built
 * catalog; `tools/call` delegates to the router with the socket's agent user as the caller
 * (allowlist + OTP + owner/mode → PAT + forward/dispatch). The token never crosses to this side.
 */
function handleConnection(socket: Socket, router: Router, catalog: Tool[], user: string): void {
	const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog }));
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const args = (req.params.arguments ?? {}) as Record<string, unknown>;
		return router.call(req.params.name, args, { user });
	});

	const transport = new StdioServerTransport(socket, socket);
	server.connect(transport).catch((err: unknown) => {
		console.error(`gh-broker: connection error: ${(err as Error).message}`);
		socket.destroy();
	});
	socket.on("close", () => void server.close().catch(() => {}));
	socket.on("error", () => {
		/* client hangup — ignore */
	});
}

/** Registered agents from the group file; an unreadable file means none (logged). */
function readAgents(groupFile: string): Agent[] {
	let text: string;
	try {
		text = readFileSync(groupFile, "utf8");
	} catch (err) {
		console.error(`gh-broker: cannot read ${groupFile} (${(err as Error).message}); serving no agents`);
		return [];
	}
	const { agents, skipped } = parseAgentGroups(text);
	for (const why of skipped) console.error(`gh-broker: ignoring agent group ${why}`);
	return agents;
}

/** Listen on one agent's socket, owned by that agent's group with mode 0660. */
function listenFor(path: string, agent: Agent, router: Router, catalog: Tool[]): Promise<void> {
	if (existsSync(path)) unlinkSync(path); // clear a stale socket from a prior run
	return new Promise((resolve, reject) => {
		const server = createServer((sock: Socket) => handleConnection(sock, router, catalog, agent.user));
		server.on("error", reject);
		server.listen(path, () => {
			try {
				chownSync(path, process.getuid?.() ?? -1, agent.gid);
			} catch (err) {
				// The socket stays owned by the service's own group, so the agent can't connect: fail closed, and say why.
				console.error(`gh-broker: cannot give ${path} to group ${agent.group} (${(err as Error).message}); ${agent.user} can't connect`);
			}
			chmodSync(path, 0o660);
			resolve();
		});
	});
}

/**
 * Listen on `<dir>/<user>.sock` for every registered agent (see src/agents.ts). The directory is
 * created (0755) if missing, sockets of agents that are no longer registered are removed, and
 * zero agents is not fatal: it is logged and nothing is served. Resolves with the agent users served.
 */
export async function startServer(config: Config, router: Router, catalog: Tool[], options: ServerOptions = {}): Promise<string[]> {
	const dir = agentsDir(config.listen);
	if (!dir) throw new Error(`server: unsupported listen "${config.listen}" (expected "agents:<absolute dir>")`);
	const agents = readAgents(options.groupFile ?? "/etc/group");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o755);
	}
	const wanted = new Set(agents.map((a) => `${a.user}.sock`));
	for (const name of readdirSync(dir)) {
		if (name.endsWith(".sock") && !wanted.has(name)) rmSync(join(dir, name), { force: true });
	}
	if (agents.length === 0) {
		console.error("gh-broker: no agents registered (no gh-broker-agent-<user> group with members gh-broker and <user>); serving nothing. Add one with: sudo gh-broker agent add <user>");
		return [];
	}
	for (const agent of agents) await listenFor(join(dir, `${agent.user}.sock`), agent, router, catalog);
	return agents.map((a) => a.user);
}
