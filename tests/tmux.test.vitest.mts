import { describe, it, expect } from "vitest";
import { configDirOf, tmuxPaneText, tmuxPanes, tmuxSend, tmuxSockets, type TmuxServer } from "../src/cli/tmux.ts";

const INFO = { uid: 1000, gid: 1000, home: "/home/repo" };
const SERVER = (socket = "/tmp/tmux-1000/default", binary = "tmux"): TmuxServer => ({ socket, binary });

/** One process in the fake /proc. stat is the real /proc/<pid>/stat shape. */
interface FakeProc {
	uid: number;
	/** fd name -> readlink target. */
	fds?: Record<string, string>;
	cmdline?: string;
	/** "<pid> (<comm>) <state> <ppid> <pgrp> <session> <tty_nr> <tpgid> ..." */
	stat?: string;
	environ?: string;
	/** readlink(/proc/<pid>/exe); undefined -> ENOENT. */
	exe?: string;
}

const stat = (pid: number | string, state = "S", ppid = 1, pgrp = 1, tpgid = 1): string => `${pid} (x) ${state} ${ppid} ${pgrp} 100 ${34828} ${tpgid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;

/** A fake /proc and /tmp for the tmux effects. Nothing real is touched. */
function host({
	dirs = {},
	files = {},
	procs = {},
	stat: statByPath = {},
	isSocket = () => true,
	owner = () => INFO.uid,
	listing,
	capture = {},
	tmuxFails = false,
	procThrows = false,
	hasSetpriv = true
}: {
	dirs?: Record<string, string[]>;
	files?: Record<string, string>;
	procs?: Record<string, FakeProc>;
	stat?: Record<string, string>;
	isSocket?: (path: string) => boolean;
	owner?: (path: string) => number;
	listing?: string;
	capture?: Record<string, string>;
	tmuxFails?: boolean;
	procThrows?: boolean;
	hasSetpriv?: boolean;
}) {
	const readdir = (path: string): string[] => {
		if (path === "/proc") {
			if (procThrows) throw new Error("EACCES");
			return Object.keys(procs);
		}
		const fd = /\/proc\/(\d+)\/fd$/.exec(path);
		if (fd) {
			const fds = procs[fd[1]!]?.fds;
			if (!fds) throw new Error("ENOENT");
			return Object.keys(fds);
		}
		const d = dirs[path];
		if (d === undefined) throw new Error("ENOENT");
		return d;
	};
	const lstat = (path: string): { uid: number; isSocket: () => boolean; isDirectory: () => boolean } => {
		const pid = /\/proc\/(\d+)$/.exec(path)?.[1];
		if (pid) return { uid: procs[pid]?.uid ?? 0, isSocket: () => false, isDirectory: () => true };
		return { uid: owner(path), isSocket: () => isSocket(path), isDirectory: () => true };
	};
	const readlink = (path: string): string => {
		const pid = /\/proc\/(\d+)\/exe$/.exec(path)?.[1];
		if (pid) {
			const exe = procs[pid]?.exe;
			if (exe === undefined) throw new Error("ENOENT");
			return exe;
		}
		const m = /\/proc\/(\d+)\/fd\/(.+)$/.exec(path);
		const target = m && procs[m[1]!]?.fds?.[m[2]!];
		if (target === undefined) throw new Error("ENOENT");
		return target;
	};
	const readHead = (path: string): string => {
		if (path in files) return files[path]!;
		if (path in statByPath) return statByPath[path]!;
		const m = /\/proc\/(\d+)\/(cmdline|environ|stat)$/.exec(path);
		const p = m && procs[m[1]!];
		if (!p) throw new Error("ENOENT");
		if (m![2] === "cmdline") return p.cmdline ?? "";
		if (m![2] === "environ") return p.environ ?? "";
		return p.stat ?? stat(m![1]!);
	};
	const exec = (cmd: string, args: string[], opts: { uid?: number; gid?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {}): { stdout: string } => {
		if (tmuxFails) throw new Error("no server running on " + args[1]);
		lastCmd = cmd;
		lastArgs = args;
		lastOpts = opts;
		if (args.includes("list-panes")) return { stdout: listing ?? "" };
		if (args.includes("capture-pane")) {
			const text = capture[args[args.indexOf("-t") + 1]!];
			if (text === undefined) throw new Error("can't capture pane: gone"); // like tmux on a dead pane
			return { stdout: text };
		}
		throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
	};
	let lastCmd = "";
	let lastArgs: string[] = [];
	let lastOpts: { uid?: number; gid?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {};
	return { proc: "/proc", tmp: "/tmp", readdir, lstat, readlink, readHead, run: exec, has: () => hasSetpriv, last: () => ({ cmd: lastCmd, args: lastArgs, opts: lastOpts }) };
}

describe("tmuxSockets", () => {
	it("finds the agent-owned sockets under /tmp/tmux-<uid>/ and skips symlinks and other owners' sockets", () => {
		const h = host({
			dirs: { "/tmp/tmux-1000": ["claude", "default", "stale", "borrowed"] },
			isSocket: (p) => !p.endsWith("stale"),
			owner: (p) => (p.endsWith("borrowed") ? 0 : INFO.uid)
		});
		expect(tmuxSockets(INFO, h)).toEqual([
			{ socket: "/tmp/tmux-1000/claude", binary: "tmux" },
			{ socket: "/tmp/tmux-1000/default", binary: "tmux" }
		]);
	});

	it("pairs a socket found through a server pid with that server's own binary, and overrides the default-dir guess", () => {
		const h = host({
			dirs: { "/tmp/tmux-1000": ["default"] },
			procs: { "500": { uid: INFO.uid, cmdline: "tmux\0-S\0/home/glm/.tmux/claude\0", fds: { 3: "socket:[77]", 4: "socket:[78]" }, exe: "/usr/local/bin/tmux" } },
			files: {
				"/proc/net/unix": [
					"Num       RefCount Protocol Flags    Type St Inode Path",
					"0000000000000000: 00000002 00000000 00010000 01 01 77 /home/glm/.tmux/claude",
					"0000000000000000: 00000002 00000000 00010000 01 01 78 /tmp/tmux-1000/default"
				].join("\n")
			}
		});
		// both sockets belong to the pid-500 server: both get its own binary, even the one the
		// default directory had already found with the PATH fallback
		expect(tmuxSockets(INFO, h)).toEqual([
			{ socket: "/home/glm/.tmux/claude", binary: "/usr/local/bin/tmux" },
			{ socket: "/tmp/tmux-1000/default", binary: "/usr/local/bin/tmux" }
		]);
	});

	it("falls back to PATH's tmux when the server's exe can't be resolved", () => {
		const h = host({
			procs: { "500": { uid: INFO.uid, cmdline: "tmux\0\0", fds: { 3: "socket:[77]" } } },
			files: {
				"/proc/net/unix": ["Num       RefCount Protocol Flags    Type St Inode Path", "0000000000000000: 00000002 00000000 00010000 01 01 77 /tmp/tmux-1000/default"].join("\n")
			}
		});
		expect(tmuxSockets(INFO, h)).toEqual([{ socket: "/tmp/tmux-1000/default", binary: "tmux" }]);
	});

	it("refuses a symlinked /tmp/tmux-<uid> directory outright", () => {
		const h = host({ dirs: {}, procs: {} });
		(h as unknown as { lstat: (p: string) => { isDirectory: () => boolean; isSocket: () => boolean; uid: number } }).lstat = (p: string) =>
			p === "/tmp/tmux-1000" ? { isDirectory: () => false, isSocket: () => false, uid: INFO.uid } : { isDirectory: () => true, isSocket: () => true, uid: INFO.uid };
		expect(tmuxSockets(INFO, h)).toEqual([]); // nothing enumerable: no default dir, no -S servers
	});

	it("ignores other users' tmux servers, the agent's non-tmux processes, and unbound sockets", () => {
		const h = host({
			procs: {
				"500": { uid: INFO.uid, cmdline: "tmux\0\0", fds: { 3: "socket:[77]" } },
				"600": { uid: 0, cmdline: "tmux\0\0", fds: { 3: "socket:[88]" } },
				"700": { uid: INFO.uid, cmdline: "bash\0", fds: { 3: "socket:[99]" } }
			},
			files: {
				"/proc/net/unix": [
					"Num       RefCount Protocol Flags    Type St Inode Path",
					"0000000000000000: 00000002 00000000 00010000 01 01 77 /tmp/tmux-1000/default",
					"0000000000000000: 00000002 00000000 00010000 01 01 88 /tmp/tmux-0/default",
					"0000000000000000: 00000002 00000000 00010000 01 01 99 ",
					"0000000000000000: 00000002 00000000 00010000 01 01 100 /tmp/tmux-1000/default"
				].join("\n")
			}
		});
		// inode 100 also maps to the default socket: the set holds it once.
		expect(tmuxSockets(INFO, h)).toEqual([{ socket: "/tmp/tmux-1000/default", binary: "tmux" }]);
	});

	it("works with no default socket directory, an unreadable /proc, and an unreadable /proc/net/unix", () => {
		const none = host({});
		expect(tmuxSockets(INFO, none)).toEqual([]);
		const noProc = host({ dirs: { "/tmp/tmux-1000": ["default"] }, procThrows: true });
		expect(tmuxSockets(INFO, noProc)).toEqual([SERVER()]);
		const noTable = host({ procs: { "500": { uid: INFO.uid, cmdline: "tmux\0\0", fds: { 3: "socket:[77]" } } } });
		expect(tmuxSockets(INFO, noTable)).toEqual([]); // /proc/net/unix unreadable: only the default dir was searched
	});
});

describe("tmuxPanes", () => {
	const proc = (pid: number, over: Partial<FakeProc> = {}): FakeProc => ({ uid: INFO.uid, cmdline: "bash\0", stat: stat(pid), ...over });
	const claudeStat = (pid: number, state = "S", ppid = 1, pgrp = pid, tpgid = pid): string =>
		`${pid} (claude) ${state} ${ppid} ${pgrp} 100 34828 ${tpgid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;

	it("lists the panes whose foreground job is the agent's own Claude Code, with screen and mode flags", () => {
		const h = host({
			listing: "%0|@|200|@|0|@|0|@|claude\n%1|@|300|@|0|@|0|@|bash\n%2|@|400|@|1|@|0|@|claude\n%3|@|500|@|0|@|1|@|bash\n",
			procs: {
				"200": proc(200, { cmdline: "claude\0", stat: claudeStat(200) }),
				// a background claude under a shell the user is typing at: same tree, not foreground
				"300": proc(300, { stat: stat(300, "S", 1, 300, 300) }),
				"301": proc(301, { cmdline: "claude\0", stat: claudeStat(301, "S", 300, 301, 300) }),
				// a Ctrl-Z'd claude: its own pgrp is the tty's, but it is stopped
				"400": proc(400, { cmdline: "claude\0", stat: claudeStat(400, "T") }),
				// another user's claude (sudo -u … claude) under the agent's shell
				"500": proc(500, { stat: stat(500, "S", 1, 500, 500) }),
				"501": proc(501, { uid: 0, cmdline: "claude\0", stat: claudeStat(501, "S", 500, 500, 500) })
			},
			capture: { "%0": "✻ Waiting for 1 background agent to finish\n\n❯ \n" }
		});
		const panes = tmuxPanes(SERVER(), INFO, h);
		expect(panes).toEqual([
			{ id: "%0", pid: 200, text: "✻ Waiting for 1 background agent to finish\n\n❯ \n", foreground: true, inMode: false, synchronized: false, configDir: undefined },
			{ id: "%1", pid: 301, text: "", foreground: false, inMode: false, synchronized: false, configDir: undefined },
			{ id: "%2", pid: 400, text: "", foreground: false, inMode: true, synchronized: false, configDir: undefined }
		]);
	});

	it("runs every tmux command as the agent through setpriv (groups kept), with the server's own binary, its HOME, a UTF-8 locale and no $TMUX", () => {
		const h = host({ listing: "", procs: {}, hasSetpriv: true });
		tmuxPanes(SERVER("/tmp/tmux-1000/default", "/usr/local/bin/tmux"), INFO, h);
		const { cmd, args, opts } = h.last();
		expect(cmd).toBe("setpriv");
		expect(args.slice(0, 5)).toEqual([`--reuid=${INFO.uid}`, `--regid=${INFO.gid}`, "--init-groups", "--", "/usr/local/bin/tmux"]);
		expect(args.slice(5)).toEqual(["-S", "/tmp/tmux-1000/default", "list-panes", "-a", "-F", "#{pane_id}|@|#{pane_pid}|@|#{pane_in_mode}|@|#{pane_synchronized}|@|#{pane_current_command}"]);
		expect(opts.uid).toBeUndefined(); // setpriv does the switch, with the agent's groups
		expect(opts.cwd).toBe("/");
		expect(opts.env!.HOME).toBe(INFO.home);
		expect(opts.env!.LANG).toBe("C.UTF-8"); // a bare locale makes tmux write `_` for the tab in -F output
		expect(opts.env!.PATH).toBeDefined();
		expect(opts.env!.TMUX).toBeUndefined();
	});

	it("falls back to a uid/gid spawn when setpriv is missing", () => {
		const h = host({ listing: "", procs: {}, hasSetpriv: false });
		tmuxPanes(SERVER("/tmp/tmux-1000/default", "/usr/bin/tmux"), INFO, h);
		const { cmd, args, opts } = h.last();
		expect(cmd).toBe("/usr/bin/tmux");
		expect(args.slice(0, 2)).toEqual(["-S", "/tmp/tmux-1000/default"]);
		expect(opts.uid).toBe(INFO.uid);
		expect(opts.gid).toBe(INFO.gid);
	});

	it("captures with -J (a wrapped indicator line must arrive joined), and reads the session's CLAUDE_CONFIG_DIR", () => {
		const calls: string[][] = [];
		const h = host({
			listing: "%0|@|200|@|0|@|0|@|claude\n",
			procs: { "200": proc(200, { cmdline: "claude\0", stat: claudeStat(200), environ: "PATH=/bin\0CLAUDE_CONFIG_DIR=/srv/glm/config/\0" }) },
			capture: { "%0": "❯ \n" }
		});
		const base = h.run;
		h.run = (cmd: string, args: string[], opts: Parameters<typeof base>[2]) => {
			calls.push(args);
			return base(cmd, args, opts);
		};
		const [p] = tmuxPanes(SERVER(), INFO, h);
		expect(p).toEqual({ id: "%0", pid: 200, text: "❯ \n", foreground: true, inMode: false, synchronized: false, configDir: "/srv/glm/config" });
		expect(calls[1]).toEqual([`--reuid=${INFO.uid}`, `--regid=${INFO.gid}`, "--init-groups", "--", SERVER().binary, "-S", SERVER().socket, "capture-pane", "-p", "-J", "-t", "%0"]);
	});

	it("returns no panes for a socket that answers nothing, drops lines it can't parse, and survives an unreadable /proc", () => {
		expect(tmuxPanes(SERVER(), INFO, host({ tmuxFails: true }))).toEqual([]);
		const h = host({ listing: "garbage\n%2|@|not-a-pid|@|0|@|0|@|claude\n", procs: {} });
		expect(tmuxPanes(SERVER(), INFO, h)).toEqual([]);
		const noProc = host({ listing: "%0|@|200|@|0|@|0|@|claude\n", procs: { "200": proc(200, { cmdline: "claude\0", stat: claudeStat(200) }) }, procThrows: true });
		expect(tmuxPanes(SERVER(), INFO, noProc)).toEqual([]);
	});
});

describe("tmuxPaneText", () => {
	it("re-captures a pane with -J, and undefined when the pane is gone", () => {
		const h = host({ capture: { "%1": "❯ \n" } });
		expect(tmuxPaneText(SERVER(), "%1", INFO, h)).toBe("❯ \n");
		expect(tmuxPaneText(SERVER(), "%2", INFO, h)).toBeUndefined();
	});
});

describe("tmuxSend", () => {
	it("sends the text literally and Enter separately, as the agent through the server's own binary", () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const h = host({});
		const base = h.run;
		h.run = (cmd: string, args: string[], opts: Parameters<typeof base>[2]) => {
			calls.push({ cmd, args });
			return { stdout: "" };
		};
		tmuxSend(SERVER("/tmp/tmux-1000/default", "/usr/bin/tmux"), "%1", "/mcp reconnect github", INFO, h);
		expect(calls).toEqual([
			{ cmd: "setpriv", args: [`--reuid=${INFO.uid}`, `--regid=${INFO.gid}`, "--init-groups", "--", "/usr/bin/tmux", "-S", "/tmp/tmux-1000/default", "send-keys", "-t", "%1", "-l", "/mcp reconnect github"] },
			{ cmd: "setpriv", args: [`--reuid=${INFO.uid}`, `--regid=${INFO.gid}`, "--init-groups", "--", "/usr/bin/tmux", "-S", "/tmp/tmux-1000/default", "send-keys", "-t", "%1", "Enter"] }
		]);
	});
});

describe("configDirOf", () => {
	it("reads CLAUDE_CONFIG_DIR from the process's environ, trimmed", () => {
		const h = host({ procs: { "400": { uid: INFO.uid, environ: "PATH=/bin\0CLAUDE_CONFIG_DIR=/srv/glm/config/\0" } } });
		expect(configDirOf(400, h)).toBe("/srv/glm/config");
		expect(configDirOf(401, host({ procs: { "400": { uid: INFO.uid, environ: "PATH=/bin\0" } } }))).toBeUndefined();
		expect(configDirOf(401, host({}))).toBeUndefined();
	});
});
