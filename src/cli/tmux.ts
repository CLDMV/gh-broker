/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/tmux.ts
 *	@Date: 2026-11-21T00:00:00-08:00 (1795248000)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-21T12:03:41-08:00 (1795291421)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The real tmux effects for `agent reconnect` (#223). Root finds an agent's tmux servers without
 * the user's server-access ACL, but every tmux command RUNS AS THE AGENT (uid/gid, a minimal env
 * without $TMUX, the agent's HOME, cwd /): tmux's own server-access check then holds, so root is
 * never the one typing into a server, and the agent only reaches what it already could. The
 * socket list is checked too: a socket counts only when it is a real socket owned by the agent
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
import { run } from "./system.ts";
import { isClaude, MAX_CMDLINE_BYTES, MAX_ENVIRON_BYTES, readHead } from "./mcp-config.ts";
import type { UserInfo } from "./agents.ts";

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
}

const resolve = ({ proc = "/proc", tmp = "/tmp", readdir = readdirSync, lstat = lstatSync, readlink = readlinkSync, readHead: head = readHead, run: exec = run }: TmuxOptions) => ({ proc, tmp, readdir, lstat, readlink, head, exec });

/** The environment a tmux command runs with as the agent: root's PATH, the agent's HOME, and deliberately no $TMUX (the client must talk to the -S socket, never an inherited one). */
const agentEnv = (info: UserInfo): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: info.home });

/** Run one tmux command as the agent user against its server socket. */
function tmux(info: UserInfo, args: string[], exec: typeof run): ReturnType<typeof run> {
	return exec("tmux", ["-S", ...args], { uid: info.uid, gid: info.gid, env: agentEnv(info), cwd: "/" });
}

/**
 * The tmux sockets a user's tmux servers listen on: sockets under /tmp/tmux-<uid>/ (that directory
 * lstat-ed, never followed through a symlink; each entry a socket the agent owns) plus the
 * listening socket of each of their tmux server processes (found through the server's own fds and
 * /proc/net/unix, every path lstat-ed and ownership-checked — a re-pointed path is refused).
 */
export function tmuxSockets(info: UserInfo, opts: TmuxOptions = {}): string[] {
	const { proc, tmp, readdir, lstat, readlink, head } = resolve(opts);
	const uid = info.uid;
	const found = new Set<string>();
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
				if (ownedSocket(path)) found.add(path);
			}
		}
	} catch {
		// no default socket directory (or it is a symlink): only -S sockets are found below
	}
	let pids: string[];
	try {
		pids = readdir(proc).filter((n) => /^\d+$/.test(n));
	} catch {
		return [...found].sort();
	}
	const inodes = new Set<string>();
	for (const pid of pids) {
		try {
			if (lstat(`${proc}/${pid}`).uid !== uid) continue;
			// basename.includes("tmux") also catches a renamed copy started with a custom -S
			// socket; the fd walk below confirms it really holds a unix socket before anything
			// is probed.
			if (!basename(head(`${proc}/${pid}/cmdline`, MAX_CMDLINE_BYTES).split("\0")[0] ?? "").includes("tmux")) continue;
			for (const fd of readdir(`${proc}/${pid}/fd`)) {
				const m = /^socket:\[(\d+)\]$/.exec(readlink(`${proc}/${pid}/fd/${fd}`));
				if (m) inodes.add(m[1]!);
			}
		} catch {
			// the process exited while being read
		}
	}
	if (inodes.size) {
		try {
			// "Num RefCount Protocol Flags Type St Inode Path": the inode names the socket, the
			// rest of the line is its path (empty for an unbound socket).
			for (const line of head(`${proc}/net/unix`, MAX_ENVIRON_BYTES).split("\n").slice(1)) {
				const cols = line.trim().split(/\s+/);
				const path = cols.slice(7).join(" ");
				if (cols[6] && inodes.has(cols[6]!) && path.startsWith("/") && ownedSocket(path)) found.add(path);
			}
		} catch {
			// /proc/net/unix can't be read: only the default directory was searched
		}
	}
	return [...found].sort();
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
export function tmuxPanes(socket: string, info: UserInfo, opts: TmuxOptions = {}): Pane[] {
	const { proc, readdir, lstat, head, exec } = resolve(opts);
	let listing: string;
	try {
		// -J joins a line the terminal wrapped (a long working-indicator line in a narrow pane
		// otherwise splits past the detectors); the format also carries the flags the skip
		// decisions need.
		listing = tmux(info, [socket, "list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}\t#{pane_in_mode}\t#{pane_synchronized}\t#{pane_current_command}"], exec).stdout;
	} catch {
		return []; // not a tmux socket the agent can reach (or no tmux): no panes
	}
	const table = processTable(proc, readdir, lstat, head);
	const childrenOf = new Map<number, number[]>();
	for (const [pid, e] of table) if (Number.isInteger(e.ppid)) childrenOf.set(e.ppid, [...(childrenOf.get(e.ppid) ?? []), pid]);
	const panes: Pane[] = [];
	for (const line of listing.split("\n")) {
		const [id, pidText, inMode, synchronized, command] = line.split("\t");
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
			text = tmux(info, [socket, "capture-pane", "-p", "-J", "-t", id], exec).stdout;
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
export function tmuxPaneText(socket: string, pane: string, info: UserInfo, opts: TmuxOptions = {}): string | undefined {
	const { exec } = resolve(opts);
	try {
		return tmux(info, [socket, "capture-pane", "-p", "-J", "-t", pane], exec).stdout;
	} catch {
		return undefined;
	}
}

/** Send literal text to a pane as the agent, then press Enter in a separate send-keys (so the text can't be eaten as key names). */
export function tmuxSend(socket: string, pane: string, text: string, info: UserInfo, opts: TmuxOptions = {}): void {
	const { exec } = resolve(opts);
	tmux(info, [socket, "send-keys", "-t", pane, "-l", text], exec);
	tmux(info, [socket, "send-keys", "-t", pane, "Enter"], exec);
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
