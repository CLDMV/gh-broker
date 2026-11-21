/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/tmux.ts
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
 * The real tmux effects for `agent reconnect` (#223). Root finds an agent's tmux servers without
 * the user's server-access ACL, but every tmux command RUNS AS THE AGENT: through `setpriv
 * --reuid --regid --init-groups` when it is available (a uid/gid spawn alone drops supplementary
 * groups, which a custom -S socket reachable only through a group needs), else a uid/gid spawn.
 * tmux's own server-access check then holds, so root is never the one typing into a server, and
 * the agent only reaches what it already could.
 *
 * Each server is talked to with ITS OWN BINARY: clients of one tmux version can't reach a server
 * of another ("server exited unexpectedly") and both may be installed, so the socket found
 * through a server's pid is paired with /proc/<pid>/exe; only sockets with no known server pid
 * (the /tmp/tmux-<uid> fallback) use PATH's tmux. The environment is minimal on purpose: the
 * agent's HOME, root's PATH, no $TMUX (the client must talk to the -S socket), and
 * LANG=C.UTF-8 — under a bare locale tmux writes `_` for the tab in -F output, which used to
 * make every pane unparseable (#223 round 3, reproduced on tmux 3.8); the -F fields are
 * separated by a printable `|@|` besides, so the listing survives either way.
 *
 * The socket list is checked: a socket counts only when it is a real socket owned by the agent
 * (the /tmp/tmux-<uid> directory is lstat-ed, never followed through a symlink, and every
 * /proc/net/unix path is lstat-ed — an agent can re-point a path after binding). A pane counts as
 * Claude Code only when a claude process owned by the agent runs in its tree AND is the pane
 * tty's foreground job (pgrp == the pane pid's tpgid, not stopped, and the pane's current command
 * is claude/node) — a Ctrl-Z'd or background claude never gets text typed into the shell above
 * it. The effects take their host access injected (defaults below are the real /proc, /tmp and
 * commands), so the unit tests never spawn anything or read a real /proc.
 */
import { basename } from "node:path";
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { has, run } from "./system.ts";
import { isClaude, MAX_CMDLINE_BYTES, MAX_ENVIRON_BYTES, readHead } from "./mcp-config.ts";
import type { UserInfo } from "./agents.ts";

/** A tmux server: its socket and the binary that owns it. */
export interface TmuxServer {
	/** The server's socket path. */
	socket: string;
	/** The tmux binary to run against this socket: the server's own /proc/<pid>/exe when its pid is known, else PATH's tmux. */
	binary: string;
}

/** One Claude Code pane on a tmux server. */
export interface Pane {
	/** tmux pane id, e.g. "%3". */
	id: string;
	/** The pid of the claude process running in the pane. */
	pid: number;
	/** The pane's screen (`tmux capture-pane -p -J`), for the busy and composer checks. */
	text: string;
	/** Whether that claude process is the pane tty's foreground job (not stopped, not background). */
	foreground: boolean;
	/** The pane is in copy mode: send-keys would run copy-mode commands, not type. */
	inMode: boolean;
	/** synchronize-panes is on: keys would go to every pane in the window. */
	synchronized: boolean;
	/** The session's CLAUDE_CONFIG_DIR, when it runs with one. */
	configDir?: string;
}

/** The host effects the tmux functions use, injectable for tests (the defaults are the real host). */
export interface TmuxOptions {
	proc?: string;
	tmp?: string;
	readdir?: typeof readdirSync;
	lstat?: typeof lstatSync;
	readlink?: typeof readlinkSync;
	readHead?: typeof readHead;
	run?: typeof run;
	has?: typeof has;
}

const resolve = ({ proc = "/proc", tmp = "/tmp", readdir = readdirSync, lstat = lstatSync, readlink = readlinkSync, readHead: head = readHead, run: exec = run, has: hasCmd = has }: TmuxOptions) => ({ proc, tmp, readdir, lstat, readlink, head, exec, hasCmd });

/** The environment a tmux command runs with as the agent: root's PATH, the agent's HOME, no $TMUX (the client must talk to the -S socket), and a UTF-8 locale (a bare one makes tmux write `_` for the tab in -F output). */
const agentEnv = (info: UserInfo): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: info.home, LANG: "C.UTF-8" });

/** The list-panes field separator: printable ASCII, so no locale can rewrite it (the tab once arrived as `_`). */
const SEP = "|@|";
const FORMAT = ["#{pane_id}", "#{pane_pid}", "#{pane_in_mode}", "#{pane_synchronized}", "#{pane_current_command}"].join(SEP);

/** Run one tmux command as the agent user against its server socket. */
function tmux(server: TmuxServer, info: UserInfo, args: string[], exec: typeof run, hasCmd: typeof has): ReturnType<typeof run> {
	// setpriv keeps the agent's supplementary groups (a uid/gid spawn drops them, which breaks a
	// -S socket reachable only through a group); without it, fall back to the uid/gid spawn.
	if (hasCmd("setpriv")) {
		return exec("setpriv", [`--reuid=${info.uid}`, `--regid=${info.gid}`, "--init-groups", "--", server.binary, "-S", server.socket, ...args], { env: agentEnv(info), cwd: "/" });
	}
	return exec(server.binary, ["-S", server.socket, ...args], { uid: info.uid, gid: info.gid, env: agentEnv(info), cwd: "/" });
}

/**
 * The tmux servers a user runs: every socket they listen on, paired with the binary to reach it
 * with. Sockets come from /tmp/tmux-<uid>/ (that directory lstat-ed, never followed through a
 * symlink; each entry a socket the agent owns) and from each tmux server process's own fds via
 * /proc/net/unix (every path lstat-ed and ownership-checked — a re-pointed path is refused); a
 * socket found through a server pid is paired with that server's /proc/<pid>/exe.
 */
export function tmuxSockets(info: UserInfo, opts: TmuxOptions = {}): TmuxServer[] {
	const { proc, tmp, readdir, lstat, readlink, head } = resolve(opts);
	const uid = info.uid;
	const servers = new Map<string, TmuxServer>();
	const ownedSocket = (path: string): boolean => {
		try {
			const st = lstat(path);
			return st.isSocket() && st.uid === uid;
		} catch {
			return false; // gone, or not reachable: not a candidate
		}
	};
	try {
		const dir = `${tmp}/tmux-${uid}`;
		if (lstat(dir).isDirectory()) {
			for (const entry of readdir(dir)) {
				const path = `${dir}/${entry}`;
				// no known server pid yet: PATH's tmux, until a server pid claims the socket below
				if (ownedSocket(path)) servers.set(path, { socket: path, binary: "tmux" });
			}
		}
	} catch {
		// no default socket directory (or it is a symlink): only -S sockets are found below
	}
	let pids: string[];
	try {
		pids = readdir(proc).filter((n) => /^\d+$/.test(n));
	} catch {
		return [...servers.values()].sort((a, b) => a.socket.localeCompare(b.socket));
	}
	const owners = new Map<string, string>(); // socket inode -> the server binary that holds it
	for (const pid of pids) {
		try {
			if (lstat(`${proc}/${pid}`).uid !== uid) continue;
			// basename.includes("tmux") also catches a renamed copy started with a custom -S
			// socket; the fd walk below confirms it really holds a unix socket before anything
			// is probed.
			if (!basename(head(`${proc}/${pid}/cmdline`, MAX_CMDLINE_BYTES).split("\0")[0] ?? "").includes("tmux")) continue;
			let binary = "tmux";
			try {
				// the server's own binary (root-owned, not agent-writable); a client of another
				// version can't reach this server ("server exited unexpectedly")
				const exe = readlink(`${proc}/${pid}/exe`);
				if (exe) binary = exe.replace(/ \(deleted\)$/, "");
			} catch {
				// exe not resolvable: PATH's tmux is the fallback
			}
			for (const fd of readdir(`${proc}/${pid}/fd`)) {
				const m = /^socket:\[(\d+)\]$/.exec(readlink(`${proc}/${pid}/fd/${fd}`));
				if (m) owners.set(m[1]!, binary);
			}
		} catch {
			// the process exited while being read
		}
	}
	if (owners.size) {
		try {
			// "Num RefCount Protocol Flags Type St Inode Path": the inode names the socket, the
			// rest of the line is its path (empty for an unbound socket).
			for (const line of head(`${proc}/net/unix`, MAX_ENVIRON_BYTES).split("\n").slice(1)) {
				const cols = line.trim().split(/\s+/);
				const path = cols.slice(7).join(" ");
				const binary = cols[6] && owners.get(cols[6]!);
				if (path.startsWith("/") && binary && ownedSocket(path)) servers.set(path, { socket: path, binary });
			}
		} catch {
			// /proc/net/unix can't be read: only the default directory was searched
		}
	}
	return [...servers.values()].sort((a, b) => a.socket.localeCompare(b.socket));
}

/** One process's argv, owner, parent, process group, tty foreground group and state, from one scan of /proc. */
interface ProcEntry {
	argv: string[];
	uid: number;
	ppid: number;
	pgrp: number;
	tpgid: number;
	state: string;
}

/** pid -> what the scan knows about it (a process that exited mid-scan is absent). */
function processTable(proc: string, readdir: typeof readdirSync, lstat: typeof lstatSync, head: typeof readHead): Map<number, ProcEntry> {
	const table = new Map<number, ProcEntry>();
	let pids: string[] = [];
	try {
		pids = readdir(proc).filter((n) => /^\d+$/.test(n));
	} catch {
		// no /proc: no panes will look like Claude Code
	}
	for (const entry of pids) {
		try {
			const pid = Number(entry);
			// stat's fields after the command name (which can contain ")"): state, ppid, pgrp,
			// session, tty_nr, tpgid, ...
			const stat = head(`${proc}/${entry}/stat`, 4096);
			const rest = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
			table.set(pid, {
				argv: head(`${proc}/${entry}/cmdline`, MAX_CMDLINE_BYTES).split("\0").filter(Boolean),
				uid: lstat(`${proc}/${entry}`).uid,
				state: rest[0] ?? "",
				ppid: Number(rest[1]),
				pgrp: Number(rest[2]),
				tpgid: Number(rest[5])
			});
		} catch {
			// the process exited while being read
		}
	}
	return table;
}

/** Every Claude Code pid among `pid` and its descendants (breadth-first, nearest first). */
function claudePidsInTree(pid: number, table: Map<number, ProcEntry>, childrenOf: Map<number, number[]>): number[] {
	const seen = new Set([pid]);
	const queue = [pid];
	const out: number[] = [];
	for (let i = 0; i < queue.length; i++) {
		const p = queue[i]!;
		if (isClaude(table.get(p)?.argv ?? [])) out.push(p);
		for (const child of childrenOf.get(p) ?? []) if (!seen.has(child)) { seen.add(child); queue.push(child); }
	}
	return out;
}

/** The Claude Code panes on one tmux server (a socket that answers nothing has none). */
export function tmuxPanes(server: TmuxServer, info: UserInfo, opts: TmuxOptions = {}): Pane[] {
	const { proc, readdir, lstat, head, exec, hasCmd } = resolve(opts);
	let listing: string;
	try {
		// -J joins a line the terminal wrapped (a long working-indicator line in a narrow pane
		// otherwise splits past the detectors); the format also carries the flags the skip
		// decisions need.
		listing = tmux(server, info, ["list-panes", "-a", "-F", FORMAT], exec, hasCmd).stdout;
	} catch {
		return []; // not a tmux socket the agent can reach (or no tmux): no panes
	}
	const table = processTable(proc, readdir, lstat, head);
	const childrenOf = new Map<number, number[]>();
	for (const [pid, e] of table) if (Number.isInteger(e.ppid)) childrenOf.set(e.ppid, [...(childrenOf.get(e.ppid) ?? []), pid]);
	const panes: Pane[] = [];
	for (const line of listing.split("\n")) {
		const [id, pidText, inMode, synchronized, command] = line.split(SEP);
		const panePid = Number(pidText);
		if (!id?.startsWith("%") || !Number.isInteger(panePid)) continue;
		const candidates = claudePidsInTree(panePid, table, childrenOf);
		if (!candidates.length) continue; // the pane isn't running Claude Code
		// The pane tty's foreground group is the pane process's tpgid; a claude that isn't in it
		// (stopped, or a background `claude -p` under a shell someone is typing at) must not be
		// typed into — it is still reported, with foreground false.
		const tpgid = table.get(panePid)?.tpgid;
		const fg = candidates.find((c) => table.get(c)?.pgrp === tpgid && table.get(c)?.state !== "T" && (command === "claude" || command === "node"));
		const claude = fg ?? candidates[0]!;
		try {
			if (lstat(`${proc}/${claude}`).uid !== info.uid) continue; // not the agent's claude
		} catch {
			continue; // it exited while being listed
		}
		let text = "";
		try {
			text = tmux(server, info, ["capture-pane", "-p", "-J", "-t", id], exec, hasCmd).stdout;
		} catch {
			// the pane died or can't be captured: an empty screen reads as "no prompt", so it is skipped
		}
		panes.push({
			id,
			pid: claude,
			text,
			foreground: fg !== undefined,
			inMode: inMode !== undefined && inMode !== "0" && inMode !== "",
			synchronized: synchronized === "1",
			configDir: configDirOf(claude, { proc, readHead: head })
		});
	}
	return panes;
}

/** Re-capture one pane's screen right before sending (the check-to-send gap); undefined when the pane is gone or can't be captured. */
export function tmuxPaneText(server: TmuxServer, pane: string, info: UserInfo, opts: TmuxOptions = {}): string | undefined {
	const { exec, hasCmd } = resolve(opts);
	try {
		return tmux(server, info, ["capture-pane", "-p", "-J", "-t", pane], exec, hasCmd).stdout;
	} catch {
		return undefined;
	}
}

/** Send literal text to a pane as the agent, then press Enter in a separate send-keys (so the text can't be eaten as key names). */
export function tmuxSend(server: TmuxServer, pane: string, text: string, info: UserInfo, opts: TmuxOptions = {}): void {
	const { exec, hasCmd } = resolve(opts);
	tmux(server, info, ["send-keys", "-t", pane, "-l", text], exec, hasCmd);
	tmux(server, info, ["send-keys", "-t", pane, "Enter"], exec, hasCmd);
}

/** The CLAUDE_CONFIG_DIR a process runs with (root can read another user's environ), or undefined. */
export function configDirOf(pid: number, opts: TmuxOptions = {}): string | undefined {
	const { proc, head } = resolve(opts);
	try {
		const env = head(`${proc}/${pid}/environ`, MAX_ENVIRON_BYTES).split("\0");
		const value = env.find((e) => e.startsWith("CLAUDE_CONFIG_DIR="))?.slice("CLAUDE_CONFIG_DIR=".length).replace(/\/+$/, "");
		return value?.startsWith("/") ? value : undefined;
	} catch {
		// the process exited, or its environ can't be read
		return undefined;
	}
}
