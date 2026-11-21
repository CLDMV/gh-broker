import { describe, it, expect } from "vitest";
import { configDirOf, tmuxPanes, tmuxSend, tmuxSockets } from "../src/cli/tmux.ts";

/** One process in the fake /proc. */
interface FakeProc {
	uid: number;
	/** fd name -> readlink target. */
	fds?: Record<string, string>;
	cmdline?: string;
	/** /proc/<pid>/stat: the ppid is parsed from after the last ")". */
	stat?: string;
	environ?: string;
}

/** A fake /proc and /tmp for the tmux effects. Nothing real is touched. */
function host({
	dirs = {},
	files = {},
	procs = {},
	isSocket = () => true,
	listing,
	capture = {},
	tmuxFails = false,
	procThrows = false
}: {
	dirs?: Record<string, string[]>;
	files?: Record<string, string>;
	procs?: Record<string, FakeProc>;
	isSocket?: (path: string) => boolean;
	listing?: string;
	capture?: Record<string, string>;
	tmuxFails?: boolean;
	procThrows?: boolean;
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
	const lstat = (path: string): { uid: number; isSocket: () => boolean } => {
		const pid = /\/proc\/(\d+)$/.exec(path)?.[1];
		if (pid) return { uid: procs[pid]?.uid ?? 0, isSocket: () => false };
		return { uid: 0, isSocket: () => isSocket(path) };
	};
	const readlink = (path: string): string => {
		const m = /\/proc\/(\d+)\/fd\/(.+)$/.exec(path);
		const target = m && procs[m[1]!]?.fds?.[m[2]!];
		if (target === undefined) throw new Error("ENOENT");
		return target;
	};
	const readHead = (path: string): string => {
		if (path in files) return files[path]!;
		const m = /\/proc\/(\d+)\/(cmdline|environ|stat)$/.exec(path);
		const p = m && procs[m[1]!];
		if (!p) throw new Error("ENOENT");
		if (m![2] === "cmdline") return p.cmdline ?? "";
		if (m![2] === "environ") return p.environ ?? "";
		return p.stat ?? `${m![1]} (x) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;
	};
	const exec = (cmd: string, args: string[]): { stdout: string } => {
		if (tmuxFails) throw new Error("no server running on " + args[1]);
		if (args.includes("list-panes")) return { stdout: listing ?? "" };
		if (args.includes("capture-pane")) return { stdout: capture[args[args.indexOf("-t") + 1]!] ?? "" };
		throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
	};
	return { proc: "/proc", tmp: "/tmp", readdir, lstat, readlink, readHead, run: exec };
}

describe("tmuxSockets", () => {
	it("finds the sockets under /tmp/tmux-<uid>/ and skips what isn't a socket", () => {
		const h = host({ dirs: { "/tmp/tmux-1000": ["claude", "default", "stale"] }, isSocket: (p) => !p.endsWith("stale") });
		expect(tmuxSockets(1000, h)).toEqual(["/tmp/tmux-1000/claude", "/tmp/tmux-1000/default"]);
	});

	it("finds a tmux server's custom -S socket through its fds and /proc/net/unix", () => {
		const h = host({
			procs: { "500": { uid: 1000, cmdline: "tmux\0-S\0/home/glm/.tmux/claude\0", fds: { 3: "socket:[77]" } } },
			files: {
				"/proc/net/unix": [
					"Num       RefCount Protocol Flags    Type St Inode Path",
					"0000000000000000: 00000002 00000000 00010000 01 01 77 /home/glm/.tmux/claude",
					"0000000000000000: 00000002 00000000 00010000 01 01 88 /run/user/0/not-the-agents"
				].join("\n")
			}
		});
		expect(tmuxSockets(1000, h)).toEqual(["/home/glm/.tmux/claude"]);
	});

	it("ignores other users' tmux servers, the agent's non-tmux processes, and unbound sockets", () => {
		const h = host({
			procs: {
				"500": { uid: 1000, cmdline: "tmux\0\0", fds: { 3: "socket:[77]" } },
				"600": { uid: 0, cmdline: "tmux\0\0", fds: { 3: "socket:[88]" } },
				"700": { uid: 1000, cmdline: "bash\0", fds: { 3: "socket:[99]" } }
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
		expect(tmuxSockets(1000, h)).toEqual(["/tmp/tmux-1000/default"]);
	});

	it("works with no default socket directory and an unreadable /proc", () => {
		const none = host({});
		expect(tmuxSockets(1000, none)).toEqual([]);
		const noProc = host({ dirs: { "/tmp/tmux-1000": ["default"] }, procThrows: true });
		expect(tmuxSockets(1000, noProc)).toEqual(["/tmp/tmux-1000/default"]);
		const noTable = host({ procs: { "500": { uid: 1000, cmdline: "tmux\0\0", fds: { 3: "socket:[77]" } } } });
		expect(tmuxSockets(1000, noTable)).toEqual([]); // /proc/net/unix unreadable: only the default dir was searched
	});
});

describe("tmuxPanes", () => {
	const proc = (pid: string, over: Partial<FakeProc> = {}): FakeProc => ({ uid: 1000, cmdline: "bash\0", stat: `${pid} (bash) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`, ...over });

	it("lists the panes whose process tree runs Claude Code, with the screen and its CLAUDE_CONFIG_DIR", () => {
		const h = host({
			listing: "%0\t200\n%1\t300\n",
			procs: {
				"200": proc("200"),
				"201": proc("201", { cmdline: "node\0/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js\0", stat: "201 (node) S 200 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0", environ: "CLAUDE_CONFIG_DIR=/srv/glm/config/\0PATH=/bin\0" }),
				"300": proc("300", { cmdline: "vim\0" })
			},
			capture: { "%0": "> \n  ? for shortcuts" }
		});
		expect(tmuxPanes("/tmp/tmux-1000/default", h)).toEqual([{ id: "%0", pid: 201, text: "> \n  ? for shortcuts", configDir: "/srv/glm/config" }]);
	});

	it("counts a pane whose own process is claude, and drops lines it can't parse", () => {
		const h = host({
			listing: "garbage\n%2\tnot-a-pid\n%3\t400\n",
			procs: { "400": proc("400", { cmdline: "claude\0" }) },
			capture: { "%3": "> hi" }
		});
		expect(tmuxPanes("/tmp/tmux-1000/default", h)).toEqual([{ id: "%3", pid: 400, text: "> hi", configDir: undefined }]);
	});

	it("returns no panes for a socket that answers nothing, and an empty screen for a pane it can't capture", () => {
		expect(tmuxPanes("/tmp/tmux-1000/default", host({ tmuxFails: true }))).toEqual([]);
		const h = host({ listing: "%0\t200\n", procs: { "200": proc("200", { cmdline: "claude\0" }) } });
		expect(tmuxPanes("/tmp/tmux-1000/default", h)).toEqual([{ id: "%0", pid: 200, text: "", configDir: undefined }]);
	});

	it("sees no Claude Code panes when /proc can't be read", () => {
		const h = host({ listing: "%0\t200\n", procs: { "200": proc("200", { cmdline: "claude\0" }) }, procThrows: true });
		expect(tmuxPanes("/tmp/tmux-1000/default", h)).toEqual([]);
	});
});

describe("tmuxSend", () => {
	it("sends the text literally and Enter separately", () => {
		const calls: string[][] = [];
		const h = host({});
		h.run = (cmd: string, args: string[]) => {
			calls.push([cmd, ...args]);
			return { stdout: "" };
		};
		tmuxSend("/tmp/tmux-1000/default", "%1", "/mcp reconnect github", h);
		expect(calls).toEqual([
			["tmux", "-S", "/tmp/tmux-1000/default", "send-keys", "-t", "%1", "-l", "/mcp reconnect github"],
			["tmux", "-S", "/tmp/tmux-1000/default", "send-keys", "-t", "%1", "Enter"]
		]);
	});
});

describe("configDirOf", () => {
	it("reads CLAUDE_CONFIG_DIR from the process's environ, trimmed", () => {
		const h = host({ procs: { "400": { uid: 1000, environ: "PATH=/bin\0CLAUDE_CONFIG_DIR=/srv/glm/config/\0" } } });
		expect(configDirOf(400, h)).toBe("/srv/glm/config");
		expect(configDirOf(401, host({ procs: { "400": { uid: 1000, environ: "PATH=/bin\0" } } }))).toBeUndefined();
		expect(configDirOf(401, host({}))).toBeUndefined();
	});
});
