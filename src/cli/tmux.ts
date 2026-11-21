/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/tmux.ts
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
 * The real tmux effects for `agent reconnect` (#223). Root finds an agent's tmux servers without
 * the user's server-access ACL: the sockets under /tmp/tmux-<uid>/ (where a server socket lives by
 * default) plus the socket of every tmux server process the user runs — a server started with
 * `tmux -S <path>` holds its own socket as an fd, and /proc/<pid>/fd plus /proc/net/unix map that
 * back to a path. A pane runs Claude Code when a process in its tree is one (mcp-config.ts knows
 * what that argv looks like), and its CLAUDE_CONFIG_DIR comes from the process's environ. The
 * effects take their host access injected (defaults below are the real /proc, /tmp and commands),
 * so the unit tests never spawn anything or read a real /proc.
 */
import { basename } from "node:path";
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { run } from "./system.ts";
import { isClaude, MAX_CMDLINE_BYTES, MAX_ENVIRON_BYTES, readHead } from "./mcp-config.ts";

/** One Claude Code pane on a tmux server. */
export interface Pane {
	/** tmux pane id, e.g. "%3". */
	id: string;
	/** The pid of the claude process running in the pane. */
	pid: number;
	/** The pane's screen (`tmux capture-pane`), for the busy and composer checks. */
	text: string;
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

/**
 * The tmux sockets a user's tmux servers listen on: everything under /tmp/tmux-<uid>/ that is a
 * socket, plus the listening socket of each of their tmux server processes (found through the
 * server's own fds, so a socket at a custom -S path is found wherever it is). Sockets nothing of
 * theirs listens on, and unbound ones, are not included.
 */
export function tmuxSockets(uid: number, opts: TmuxOptions = {}): string[] {
	const { proc, tmp, readdir, lstat, readlink, head } = resolve(opts);
	const found = new Set<string>();
	try {
		for (const entry of readdir(`${tmp}/tmux-${uid}`)) {
			const path = `${tmp}/tmux-${uid}/${entry}`;
			if (lstat(path).isSocket()) found.add(path);
		}
	} catch {
		// no default socket directory: only -S sockets are found below
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
			if (basename(head(`${proc}/${pid}/cmdline`, MAX_CMDLINE_BYTES).split("\0")[0] ?? "") !== "tmux") continue;
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
				if (cols[6] && inodes.has(cols[6]!) && path.startsWith("/")) found.add(path);
			}
		} catch {
			// /proc/net/unix can't be read: only the default directory was searched
		}
	}
	return [...found].sort();
}

/** pid -> its children, and pid -> its argv, from one scan of /proc. */
function processTree(proc: string, readdir: typeof readdirSync, head: typeof readHead): { childrenOf: (pid: number) => number[]; argvOf: (pid: number) => string[] } {
	const children = new Map<number, number[]>();
	const argvs = new Map<number, string[]>();
	let pids: string[] = [];
	try {
		pids = readdir(proc).filter((n) => /^\d+$/.test(n));
	} catch {
		// no /proc: no panes will look like Claude Code
	}
	for (const entry of pids) {
		try {
			const pid = Number(entry);
			// stat's fields after the command name: state, then ppid (the command can contain ")").
			const stat = head(`${proc}/${entry}/stat`, 4096);
			const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[1]);
			if (Number.isInteger(ppid)) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
			argvs.set(pid, head(`${proc}/${entry}/cmdline`, MAX_CMDLINE_BYTES).split("\0").filter(Boolean));
		} catch {
			// the process exited while being read
		}
	}
	return { childrenOf: (pid) => children.get(pid) ?? [], argvOf: (pid) => argvs.get(pid) ?? [] };
}

/** The pid of a Claude Code process among `pid` and its descendants, or undefined. */
function claudeInTree(pid: number, childrenOf: (pid: number) => number[], argvOf: (pid: number) => string[]): number | undefined {
	const seen = new Set([pid]);
	const queue = [pid];
	for (let i = 0; i < queue.length; i++) {
		const p = queue[i]!;
		if (isClaude(argvOf(p))) return p;
		for (const child of childrenOf(p)) if (!seen.has(child)) queue.push(child);
	}
	return undefined;
}

/** The Claude Code panes on one tmux server (a socket that answers nothing has none). */
export function tmuxPanes(socket: string, opts: TmuxOptions = {}): Pane[] {
	const { proc, readdir, head, exec } = resolve(opts);
	let listing: string;
	try {
		listing = exec("tmux", ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}"]).stdout;
	} catch {
		return []; // not a tmux socket (or no tmux): no panes
	}
	const tree = processTree(proc, readdir, head);
	const panes: Pane[] = [];
	for (const line of listing.split("\n")) {
		const [id, pidText] = line.split("\t");
		const panePid = Number(pidText);
		if (!id?.startsWith("%") || !Number.isInteger(panePid)) continue;
		const claude = claudeInTree(panePid, tree.childrenOf, tree.argvOf);
		if (claude === undefined) continue; // the pane isn't running Claude Code
		let text = "";
		try {
			text = exec("tmux", ["-S", socket, "capture-pane", "-p", "-t", id]).stdout;
		} catch {
			// the pane died or can't be captured: an empty screen reads as "no prompt", so it is skipped
		}
		panes.push({ id, pid: claude, text, configDir: configDirOf(claude, { proc, readHead: head }) });
	}
	return panes;
}

/** Send literal text to a pane, then press Enter in a separate send-keys (so the text can't be eaten as key names). */
export function tmuxSend(socket: string, pane: string, text: string, opts: TmuxOptions = {}): void {
	const { exec } = resolve(opts);
	exec("tmux", ["-S", socket, "send-keys", "-t", pane, "-l", text]);
	exec("tmux", ["-S", socket, "send-keys", "-t", pane, "Enter"]);
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
