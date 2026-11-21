/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/reconnect.ts
 *	@Date: 2026-11-21T00:00:00-08:00 (1795248000)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-21T11:28:19-08:00 (1795289299)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * `gh-broker agent reconnect` (#223): send `/mcp reconnect <key>` to each running Claude Code
 * session of a registered agent (or one agent). The key is the agent's actual `mcpServers` entry
 * for the broker, read back from its `.claude.json` files — mcp-config.ts writes those entries, so
 * brokerKeyOf knows what one looks like wherever it is. The sessions are found as root through
 * every tmux server the agent user runs (src/cli/tmux.ts), without the user's server-access ACL.
 * A pane is only sent to when its composer is empty and Claude isn't working, so nothing being
 * typed is clobbered; skipped panes are listed with their id so they can be retried. Every effect
 * is injected.
 */
import { agentsDir, assertAgentName, registeredAgents, type Group, type UserInfo } from "./agents.ts";
import { brokerKeyOf, extraFolders, inFolder, MCP_FILE, type FolderIo, type Place } from "./mcp-config.ts";
import type { Pane } from "./tmux.ts";
import type { ConfigLayer } from "./config-merge.ts";

/** The effects `agent reconnect` (and `upgrade`'s last step) use. */
export interface ReconnectDeps {
	log: (m: string) => void;
	error: (m: string) => void;
	groups: () => Group[];
	userInfo: (user: string) => UserInfo | undefined;
	mcpIO: FolderIo;
	/** The tmux sockets the user's tmux servers listen on. */
	tmuxSockets: (uid: number) => string[];
	/** The Claude Code panes on one tmux server. */
	tmuxPanes: (socket: string) => Pane[];
	/** Send literal text to a pane and press Enter (tmux send-keys -l for the text, a separate Enter). */
	tmuxSend: (socket: string, pane: string, text: string) => void;
	/** The CLAUDE_CONFIG_DIR of a running process, when it has one. */
	paneConfigDir: (pid: number) => string | undefined;
}

/**
 * Heuristics over Claude Code's screen, from the captured pane text. The TUI changes between
 * versions, so they err toward skipping a pane: one is only sent to when its input line is
 * visibly empty and nothing suggests Claude is working. A skipped pane is listed with its id,
 * so it can be retried.
 */

/** Claude Code's working-indicator line: a spinner glyph, an action and an ellipsis, optionally with a parenthetical ("✻ Fixing things… (esc to interrupt · 32s)"). */
const WORKING = /^[^\w\s>!#] .+…(?: \([^)]*\))?$/;

/** Whether Claude Code is busy in the pane: a working-indicator line, or the "esc to interrupt" hint it shows while working. */
export function busyPane(text: string): boolean {
	return text.split("\n").some((line) => {
		const l = line.replace(/\s+$/, "");
		return l.includes("esc to interrupt") || WORKING.test(l);
	});
}

/** The state of Claude Code's input line in the pane: "empty" (a "> " line with nothing typed), "typing" (text in it) or "none" (no input line on screen — a dialog, or bash/memory input mode). */
export function composerState(text: string): "empty" | "typing" | "none" {
	const lines = text.split("\n");
	// The input line is the bottom-most ">" line: user messages in the transcript carry a ">" too,
	// but the input line sits under them (and is what a skip must protect).
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = /^>(?: (.*))?$/.exec(lines[i]!.replace(/\s+$/, ""));
		if (!m) continue;
		return m[1]?.trim() ? "typing" : "empty";
	}
	return "none";
}

/** Split `agent reconnect` arguments into the agent users (at most one) and --dry-run. */
function parseReconnectArgs(rest: string[]): { users: string[]; dryRun: boolean } {
	const users: string[] = [];
	let dryRun = false;
	for (const a of rest) {
		if (a === "--dry-run") dryRun = true;
		else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
		else users.push(a);
	}
	if (users.length > 1) throw new Error("name at most one agent user: sudo gh-broker agent reconnect [<user>]");
	return { users, dryRun };
}

/** The broker key in each of the agent's `.claude.json` files that has one, by folder. */
function keysOf(places: Place[], info: UserInfo, dir: string, d: { mcpIO: FolderIo }): Map<string, string> {
	const keys = new Map<string, string>();
	for (const place of places) {
		try {
			const key = inFolder(place, info, d, (io) => brokerKeyOf(io.read(`${place.folder}/${MCP_FILE}`, info.uid)?.text, dir));
			if (key) keys.set(place.folder, key);
		} catch {
			// a folder root won't use (SkippedFolder), or an unreadable file: it contributes no key
		}
	}
	return keys;
}

/** The key to send to a pane: the one in the session's own config folder's file, else the home file's, else any of the agent's files'. */
function keyFor(pane: Pane, info: UserInfo, keys: Map<string, string>): string | undefined {
	return (pane.configDir && keys.get(pane.configDir)) || keys.get(info.home) || [...keys.values()][0];
}

/**
 * Run one `agent reconnect`. Returns the exit code: 0 when every pane found was sent to (or
 * there were none), 1 when any pane was skipped or a user is missing.
 */
export function reconnect(rest: string[], config: ConfigLayer, d: ReconnectDeps): number {
	const { users, dryRun } = parseReconnectArgs(rest);
	const dir = agentsDir(config.listen);
	const registered = registeredAgents(d.groups()).map((a) => a.user);
	for (const user of users) {
		assertAgentName(user);
		if (!registered.includes(user)) throw new Error(`"${user}" is not a registered agent`);
	}
	let sent = 0;
	let skipped = 0;
	for (const user of users.length ? users : registered) {
		const info = d.userInfo(user);
		if (!info) {
			d.error(`${user}: no such user`);
			skipped++;
			continue;
		}
		const places: Place[] = [{ folder: info.home, saved: false }, ...extraFolders(info, d, config, user)];
		const keys = keysOf(places, info, dir, d);
		let panes = 0;
		const sockets = d.tmuxSockets(info.uid);
		for (const socket of sockets) {
			for (const pane of d.tmuxPanes(socket)) {
				panes++;
				const key = keyFor(pane, info, keys);
				if (!key) {
					d.log(`${user} ${socket} ${pane.id} - skipped (no broker MCP entry in its .claude.json files)`);
					skipped++;
					continue;
				}
				if (busyPane(pane.text)) {
					d.log(`${user} ${socket} ${pane.id} ${key} skipped (busy: Claude is working)`);
					skipped++;
					continue;
				}
				const composer = composerState(pane.text);
				if (composer === "typing") {
					d.log(`${user} ${socket} ${pane.id} ${key} skipped (composer not empty)`);
					skipped++;
					continue;
				}
				if (composer === "none") {
					d.log(`${user} ${socket} ${pane.id} ${key} skipped (no Claude Code prompt on screen)`);
					skipped++;
					continue;
				}
				if (dryRun) {
					d.log(`${user} ${socket} ${pane.id} ${key} would send`);
				} else {
					try {
						d.tmuxSend(socket, pane.id, `/mcp reconnect ${key}`);
					} catch (err) {
						d.log(`${user} ${socket} ${pane.id} ${key} skipped (send failed: ${(err as Error).message})`);
						skipped++;
						continue;
					}
					d.log(`${user} ${socket} ${pane.id} ${key} sent`);
				}
				sent++;
			}
		}
		if (panes === 0) d.log(`${user}: no Claude Code sessions running${sockets.length ? "" : " (no tmux server)"}`);
	}
	d.log(dryRun ? `dry run: ${sent} pane(s) would get "/mcp reconnect"` : `sent ${sent}, skipped ${skipped}`);
	return skipped === 0 ? 0 : 1;
}
