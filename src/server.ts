import { createServer, type Socket } from "node:net";
import { chmodSync, chownSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./types.ts";
import type { Router } from "./router.ts";

const SERVER_INFO = { name: "gh-broker", version: "0.1.0" };

function socketPath(listen: string): string {
	if (!listen.startsWith("unix:")) throw new Error(`server: unsupported listen "${listen}"`);
	return listen.slice("unix:".length);
}

/** Resolve a group name → gid via /etc/group (no native Node API for this). */
function groupGid(name: string): number | undefined {
	try {
		for (const line of readFileSync("/etc/group", "utf8").split("\n")) {
			const parts = line.split(":");
			if (parts[0] === name && parts[2]) return Number(parts[2]);
		}
	} catch {
		/* ignore — fall back to RuntimeDirectory perms */
	}
	return undefined;
}

/**
 * Each agent connection (a socat stdio bridge to our Unix socket) gets its own MCP
 * Server over a StdioServerTransport bound to that socket. `tools/list` returns the
 * pre-built catalog; `tools/call` delegates to the router (allowlist + owner/mode →
 * PAT + forward/dispatch). The token never crosses to this side.
 */
function handleConnection(socket: Socket, router: Router, catalog: Tool[]): void {
	const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog }));
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const args = (req.params.arguments ?? {}) as Record<string, unknown>;
		return router.call(req.params.name, args);
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

export function startServer(config: Config, router: Router, catalog: Tool[]): Promise<void> {
	const path = socketPath(config.listen);
	if (existsSync(path)) unlinkSync(path); // clear a stale socket from a prior run

	return new Promise((resolve, reject) => {
		const server = createServer((sock: Socket) => handleConnection(sock, router, catalog));
		server.on("error", reject);
		server.listen(path, () => {
			// Restrict the socket to the agent-clients group: chgrp to gh-broker-clients,
			// mode 0660 (owner+group rw). The agent user is a member of that group.
			const group = process.env.GH_BROKER_SOCKET_GROUP ?? "gh-broker-clients";
			const gid = groupGid(group);
			try {
				if (gid !== undefined) chownSync(path, process.getuid?.() ?? -1, gid);
				chmodSync(path, 0o660);
			} catch {
				/* best-effort; RuntimeDirectory perms already restrict access */
			}
			resolve();
		});
	});
}
