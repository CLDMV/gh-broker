import { describe, it, expect, vi } from "vitest";
import { agentCommand, configureMcp, smokeAgent } from "../deploy/lib/agent-cli.mjs";
import { mcpEntry, SkippedFolder, UnsafeFile } from "../deploy/lib/mcp-config.mjs";
import { emptyState, emptyUser } from "../deploy/lib/otp.mjs";
import { makeDeps, config, NOW } from "./helpers/cli-deps.mjs";

const DIR = "/run/gh-broker/agents";
const OLD = { type: "stdio", command: "sg", args: ["gh-broker-clients", "-c", "exec socat STDIO UNIX-CONNECT:/run/gh-broker/gh-broker.sock"] };
const claude = (u: string) => `/home/${u}/.claude.json`;
/** An MCP config reader that finds every agent's file planted as a symlink. */
const unsafeIO = { read: (p: string) => { throw new UnsafeFile(`${p} is a symlink`); }, write: () => { throw new Error("must not write"); } };

describe("agent add", () => {
	it("registers the group, writes the MCP config, restarts and smoke-tests the agent's socket", async () => {
		const { d, out, files } = makeDeps();
		expect(await agentCommand("add", ["newbie"], config, d)).toBe(0);
		expect(d.ensureGroup).toHaveBeenCalledWith("newbie");
		expect(JSON.parse(files[claude("newbie")])).toEqual({ mcpServers: { github: mcpEntry("newbie", DIR) } });
		expect(d.restart).toHaveBeenCalled();
		expect(d.smoke).toHaveBeenCalledWith("/run/gh-broker/agents/newbie.sock");
		expect(out.join("\n")).toContain("registered (group gh-broker-agent-newbie)");
		expect(out.join("\n")).toContain("restart the user's running Claude sessions");
		expect(out.join("\n")).toContain("broker answered on /run/gh-broker/agents/newbie.sock (3 tools)");
	});

	it("exits 1 when the smoke test fails, after configuring", async () => {
		const { d, err } = makeDeps({ smoke: async () => { throw new Error("ECONNREFUSED"); } });
		expect(await agentCommand("add", ["newbie"], config, d)).toBe(1);
		expect(err[0]).toContain("smoke test failed on /run/gh-broker/agents/newbie.sock: ECONNREFUSED");
	});

	it("--no-mcp-config prints the entry instead of writing", async () => {
		const { d, out, writes } = makeDeps();
		await agentCommand("add", ["newbie", "--no-mcp-config"], config, d);
		expect(writes).toEqual([]);
		expect(out.join("\n")).toContain("not writing the MCP config (--no-mcp-config)");
		expect(out.join("\n")).toContain('"command": "sg"');
	});

	it("validates the name, needs the user to exist, and takes exactly one name", async () => {
		const { d } = makeDeps();
		await expect(agentCommand("add", ["Bad Name"], config, d)).rejects.toThrow(/not a valid agent user name/);
		await expect(agentCommand("add", ["ghost"], config, d)).rejects.toThrow(/user "ghost" does not exist/);
		await expect(agentCommand("add", [], config, d)).rejects.toThrow(/name the agent user: sudo gh-broker agent add <user>/);
		expect(d.ensureGroup).not.toHaveBeenCalled();
	});
});

describe("configureMcp", () => {
	it("updates an old shared-socket entry in place and mentions the backup", () => {
		const { d, out, files } = makeDeps({}, { [claude("repo")]: JSON.stringify({ mcpServers: { github: OLD } }) });
		expect(configureMcp("repo", config, d)).toBe("written");
		expect(JSON.parse(files[claude("repo")]).mcpServers.github).toEqual(mcpEntry("repo", DIR));
		expect(out[0]).toContain('MCP config written in /home/repo/.claude.json (entry "github"); previous file saved as .claude.json.gh-broker.bak');
	});

	it("reports an already-correct config without writing", () => {
		const { d, out, writes } = makeDeps({}, { [claude("repo")]: JSON.stringify({ mcpServers: { github: mcpEntry("repo", DIR) } }) });
		expect(configureMcp("repo", config, d)).toBe("unchanged");
		expect(writes).toEqual([]);
		expect(out[0]).toContain("already up to date");
	});

	it("prints the entry for an unparseable file and for a missing user", () => {
		const bad = makeDeps({}, { [claude("repo")]: "{nope" });
		expect(configureMcp("repo", config, bad.d)).toBe("unreadable");
		expect(bad.out.join("\n")).toContain("is not valid JSON, so it was left alone");
		const ghost = makeDeps();
		expect(configureMcp("ghost", config, ghost.d)).toBe("skipped");
		expect(ghost.out[0]).toContain("(no such user)");
	});

	it("leaves an unsafe file (a symlink, someone else's file) alone and prints the entry", () => {
		const { d, err, out, writes } = makeDeps({ mcpIO: unsafeIO });
		expect(configureMcp("repo", config, d)).toBe("unsafe");
		expect(writes).toEqual([]);
		expect(err[0]).toBe('repo: /home/repo/.claude.json is a symlink, so it was left alone (root won\'t read or replace it). Make it a plain file the user owns and run "sudo gh-broker agent sync repo", or add this under "mcpServers" by hand:');
		expect(out[0]).toContain('"command": "sg"');
	});

	it("reports a write that fails in the agent's home and carries on", () => {
		const { d, err, out } = makeDeps({ mcpIO: { read: () => undefined, write: () => { throw new Error("EISDIR: illegal operation on a directory"); } } });
		expect(configureMcp("repo", config, d)).toBe("failed");
		expect(err[0]).toBe('repo: could not write the MCP config: EISDIR: illegal operation on a directory. Add this under "mcpServers" in the user\'s ~/.claude.json by hand:');
		expect(out[0]).toContain('"command": "sg"');
	});

	it("uses the socket directory from the config's listen", () => {
		const { d, files } = makeDeps();
		configureMcp("repo", { listen: "agents:/run/other" }, d);
		expect(files[claude("repo")]).toContain("/run/other/repo.sock");
	});
});

describe("smokeAgent", () => {
	it("returns whether the socket answered", async () => {
		const ok = makeDeps();
		expect(await smokeAgent("repo", config, ok.d)).toBe(true);
		const bad = makeDeps({ smoke: async () => { throw new Error("nope"); } });
		expect(await smokeAgent("repo", config, bad.d)).toBe(false);
	});
});

describe("agent remove", () => {
	const registered = { files: { [claude("repo")]: JSON.stringify({ mcpServers: { github: mcpEntry("repo", DIR), x: { command: "npx" } } }) } };

	it("removes the MCP entry (backup first), the group and the user's lock state, then restarts", async () => {
		const state = { status: "ok", state: { ...emptyState(), users: { repo: emptyUser(), glmtest: emptyUser() } } };
		const { d, out, files } = makeDeps({ readState: () => state }, registered.files);
		expect(await agentCommand("remove", ["repo"], config, d)).toBe(0);
		expect(JSON.parse(files[claude("repo")])).toEqual({ mcpServers: { x: { command: "npx" } } });
		expect(files["/home/repo/.claude.json.gh-broker.bak"]).toBeDefined();
		expect(d.removeGroup).toHaveBeenCalledWith("repo");
		expect(d.writeState).toHaveBeenCalledWith("/var/lib/gh-broker/otp-state.json", { version: 1, lastAcceptedStep: Math.floor(NOW / 30000) + 1, users: { glmtest: emptyUser() } });
		expect(d.restart).toHaveBeenCalled();
		expect(out.join("\n")).toContain("removed the broker entry from /home/repo/.claude.json");
	});

	it("copes with no entry, no file, an unreadable file, a vanished user, and no lock state", async () => {
		const noEntry = makeDeps({}, { [claude("repo")]: "{}" });
		await agentCommand("remove", ["repo"], config, noEntry.d);
		expect(noEntry.out.join("\n")).toContain("no broker entry in /home/repo/.claude.json");
		const noFile = makeDeps();
		await agentCommand("remove", ["repo"], config, noFile.d);
		expect(noFile.out.join("\n")).toContain("no .claude.json to edit");
		expect(noFile.d.writeState).not.toHaveBeenCalled();
		const bad = makeDeps({}, { [claude("repo")]: "{nope" });
		await agentCommand("remove", ["repo"], config, bad.d);
		expect(bad.out.join("\n")).toContain("not valid JSON, so it was left alone");
		const unsafe = makeDeps({ mcpIO: unsafeIO });
		await agentCommand("remove", ["repo"], config, unsafe.d);
		expect(unsafe.out.join("\n")).toContain("repo: /home/repo/.claude.json is a symlink, so it was left alone");
		const order: string[] = [];
		const blocked = makeDeps({
			removeGroup: () => order.push("group"),
			restart: () => order.push("restart"),
			mcpIO: { read: () => { order.push("mcp"); return { text: JSON.stringify({ mcpServers: { github: mcpEntry("repo", DIR) } }), stat: { uid: 1000, gid: 1000, mode: 0o100600 } }; }, write: () => { throw new Error("EISDIR"); } }
		});
		expect(await agentCommand("remove", ["repo"], config, blocked.d)).toBe(0);
		expect(order).toEqual(["group", "restart", "mcp"]);
		expect(blocked.err[0]).toBe("repo: could not remove the broker entry from /home/repo/.claude.json: EISDIR. The agent is unregistered anyway; remove the entry by hand.");
		const gone = makeDeps({ userInfo: () => undefined });
		await agentCommand("remove", ["repo"], config, gone.d);
		expect(gone.d.removeGroup).toHaveBeenCalledWith("repo");
	});

	it("still restarts when clearing the lock state fails (the broker wrote the file meanwhile)", async () => {
		const state = { status: "ok", state: { ...emptyState(), users: { repo: emptyUser() } } };
		const { d, err } = makeDeps({ readState: () => state, writeState: () => { throw new Error("changed while this command ran"); } });
		expect(await agentCommand("remove", ["repo"], config, d)).toBe(0);
		expect(err[0]).toBe('repo: lock state not cleared: changed while this command ran. "sudo gh-broker otp unlock repo" clears it later.');
		expect(d.restart).toHaveBeenCalled();
	});

	it("warns when the state file is corrupt instead of editing it", async () => {
		const { d, err } = makeDeps({ readState: () => ({ status: "corrupt", state: emptyState() }) });
		await agentCommand("remove", ["repo"], config, d);
		expect(d.writeState).not.toHaveBeenCalled();
		expect(err[0]).toContain("is corrupt, so repo's entry was not cleared");
	});

	it("refuses an unregistered or invalid name", async () => {
		const { d } = makeDeps();
		await expect(agentCommand("remove", ["nobody"], config, d)).rejects.toThrow(/"nobody" is not a registered agent/);
		await expect(agentCommand("remove", ["Bad Name"], config, d)).rejects.toThrow(/not a valid agent user name/);
		expect(d.removeGroup).not.toHaveBeenCalled();
	});
});

describe("agent list", () => {
	it("shows each agent's socket, whether it exists, and the MCP status", async () => {
		const { d, out } = makeDeps({ socketExists: (p: string) => p.includes("repo") }, { [claude("repo")]: JSON.stringify({ mcpServers: { github: mcpEntry("repo", DIR) } }), [claude("glmtest")]: JSON.stringify({ mcpServers: { github: OLD } }) });
		expect(await agentCommand("list", [], config, d)).toBe(0);
		expect(out).toContain("repo  /run/gh-broker/agents/repo.sock  socket: yes  mcp: ok");
		expect(out).toContain("glmtest  /run/gh-broker/agents/glmtest.sock  socket: no  mcp: points elsewhere  (group members incomplete; run agent add)");
		const unsafe = makeDeps({ mcpIO: unsafeIO });
		await agentCommand("list", [], config, unsafe.d);
		expect(unsafe.out).toContain("repo  /run/gh-broker/agents/repo.sock  socket: yes  mcp: unsafe (/home/repo/.claude.json is a symlink)");
		const broken = makeDeps({ mcpIO: { read: (p: string) => { if (p.includes("glmtest")) throw new Error("ERR_STRING_TOO_LONG"); return undefined; }, write: () => {} } });
		expect(await agentCommand("list", [], config, broken.d)).toBe(0);
		expect(broken.out).toContain("glmtest  /run/gh-broker/agents/glmtest.sock  socket: yes  mcp: can't read (ERR_STRING_TOO_LONG)  (group members incomplete; run agent add)");
		expect(broken.out).toContain("repo  /run/gh-broker/agents/repo.sock  socket: yes  mcp: missing");
	});

	it("handles no agents, a missing user, a missing config, and version drift", async () => {
		const none = makeDeps({ groups: () => [] });
		await agentCommand("list", [], config, none.d);
		expect(none.out[0]).toContain("no agents registered");
		const ghost = makeDeps({ groups: () => [{ name: "gh-broker-agent-ghost", gid: 1, members: ["gh-broker", "ghost"] }], versions: () => ({ pkg: "2", deployed: "1" }) });
		await agentCommand("list", [], config, ghost.d);
		expect(ghost.out[0]).toContain("mcp: no such user");
		expect(ghost.err[0]).toContain("run \"sudo gh-broker install\"");
		const missing = makeDeps();
		await agentCommand("list", [], config, missing.d);
		expect(missing.out[0]).toContain("mcp: missing");
	});
});

describe("agent sync", () => {
	it("re-applies one agent or all of them", async () => {
		const one = makeDeps();
		expect(await agentCommand("sync", ["repo"], config, one.d)).toBe(0);
		expect(Object.keys(one.files)).toEqual([claude("repo")]);
		const all = makeDeps();
		await agentCommand("sync", [], config, all.d);
		expect(Object.keys(all.files).sort()).toEqual([claude("glmtest"), claude("repo")]);
	});

	it("exits 1 when any agent's config could not be written", async () => {
		const { d } = makeDeps({ mcpIO: unsafeIO });
		expect(await agentCommand("sync", [], config, d)).toBe(1);
	});

	it("--no-mcp-config only prints, and an unknown agent is refused", async () => {
		const { d, writes } = makeDeps();
		await agentCommand("sync", ["--no-mcp-config"], config, d);
		expect(writes).toEqual([]);
		await expect(agentCommand("sync", ["nobody"], config, d)).rejects.toThrow(/not a registered agent/);
		await expect(agentCommand("sync", ["Bad Name"], config, d)).rejects.toThrow(/not a valid agent user name/);
	});
});

describe("other Claude config folders (#163)", () => {
	const SEC = "/home/repo/.claude-secondary";
	const VLLM = "/srv/claude-vllm";
	const SAVED = "/data/claude-saved";
	const ok = (files: Record<string, string>) => makeDeps({}, files).d.mcpIO;
	/** Folders found by the home scan and the running sessions; `pins` records each pin as "folder|within". */
	const withFolders = (files: Record<string, string>, over: Record<string, unknown> = {}) => {
		const deps = makeDeps({ writeConfig: vi.fn() }, files);
		const pins: string[] = [];
		const base = deps.d.mcpIO;
		deps.d.mcpIO = {
			...base,
			scan: (home: string) => (home === "/home/repo" ? ["/home/repo/.claude", SEC] : []),
			sessions: (uid: number) => (uid === 1000 ? [SEC, VLLM, "/home/repo"] : []),
			pin: (folder: string, _uid: number, within?: string) => {
				pins.push(`${folder}|${within ?? "-"}`);
				return { io: base, close: () => pins.push(`closed ${folder}`) };
			},
			...over
		};
		return { ...deps, pins };
	};

	it("sync updates every folder that has a .claude.json, skips the rest, and confines found folders to the home", async () => {
		const { d, out, files, pins } = withFolders({ [`${SEC}/.claude.json`]: JSON.stringify({ mcpServers: { github: OLD } }), [`${VLLM}/.claude.json`]: "{}" });
		expect(await agentCommand("sync", ["repo"], config, d)).toBe(0);
		expect(JSON.parse(files[`${SEC}/.claude.json`]).mcpServers.github).toEqual(mcpEntry("repo", DIR));
		expect(JSON.parse(files[`${VLLM}/.claude.json`]).mcpServers.github).toEqual(mcpEntry("repo", DIR));
		expect(files["/home/repo/.claude/.claude.json"]).toBeUndefined(); // no file there: not created
		expect(pins).toEqual(["/home/repo/.claude|/home/repo", "closed /home/repo/.claude", `${SEC}|/home/repo`, `closed ${SEC}`, `${VLLM}|/home/repo`, `closed ${VLLM}`]);
		expect(out).toContain(`repo: MCP config written in ${SEC}/.claude.json (entry "github"); previous file saved as .claude.json.gh-broker.bak`);
		expect(out.filter((l: string) => l.includes("restart the user's running Claude sessions"))).toHaveLength(1);
	});

	it("saved folders come first, aren't confined to the home, and aren't repeated", async () => {
		const { d, pins } = withFolders({}, {});
		await agentCommand("sync", ["repo"], { ...config, claudeConfigDirs: { repo: [SAVED, SEC], other: ["/x"] } }, d);
		expect(pins.filter((p) => !p.startsWith("closed"))).toEqual([`${SAVED}|-`, `${SEC}|-`, "/home/repo/.claude|/home/repo", `${VLLM}|/home/repo`]);
	});

	it("a folder root won't use is skipped with a warning and doesn't fail the sync", async () => {
		const { d, err, out } = withFolders({ [`${VLLM}/.claude.json`]: "{}" }, {
			pin: (folder: string) => {
				if (folder === SEC) throw new SkippedFolder(`${SEC} is owned by uid 0, not the agent user (uid 1000)`);
				return folder === VLLM ? { io: ok({ [`${VLLM}/.claude.json`]: "{}" }), close: () => {} } : undefined;
			}
		});
		expect(await agentCommand("sync", ["repo"], config, d)).toBe(0);
		expect(err).toEqual([`repo: skipped ${SEC} is owned by uid 0, not the agent user (uid 1000)`]);
		expect(out.join("\n")).toContain(`MCP config written in ${VLLM}/.claude.json`);
	});

	it("a failed write in another folder is reported with its path and fails the sync", async () => {
		const { d, err } = withFolders({}, {
			pin: (folder: string) => (folder === SEC ? { io: { read: () => ({ text: "{}", stat: { uid: 1000, gid: 1000, mode: 0o100600 } }), write: () => { throw new Error("ENOSPC"); } }, close: () => {} } : undefined)
		});
		expect(configureMcp("repo", config, d)).toBe("failed");
		expect(err[0]).toBe(`repo: could not write the MCP config in ${SEC}/.claude.json: ENOSPC. Add this under "mcpServers" in ${SEC}/.claude.json by hand:`);
		expect(await agentCommand("sync", ["repo"], config, d)).toBe(1);
	});

	it("an unsafe or unreadable file in another folder counts, and the first bad result wins", () => {
		const unchanged = withFolders({ [claude("repo")]: JSON.stringify({ mcpServers: { github: mcpEntry("repo", DIR) } }) }, { pin: () => undefined });
		expect(configureMcp("repo", config, unchanged.d)).toBe("unchanged");
		const unsafe = withFolders({}, { pin: (folder: string) => (folder === SEC ? { io: unsafeIO, close: () => {} } : undefined) });
		expect(configureMcp("repo", config, unsafe.d)).toBe("unsafe");
		const both = withFolders({ [claude("repo")]: "{nope" }, { pin: (folder: string) => (folder === SEC ? { io: unsafeIO, close: () => {} } : undefined) });
		expect(configureMcp("repo", config, both.d)).toBe("unreadable");
		const late = withFolders({}, { pin: (folder: string) => (folder === SEC ? { io: ok({ [`${SEC}/.claude.json`]: "{nope" }), close: () => {} } : undefined) });
		expect(configureMcp("repo", config, late.d)).toBe("unreadable");
	});

	it("add and sync save --claude-config folders in the broker config", async () => {
		const add = withFolders({});
		expect(await agentCommand("add", ["repo", "--claude-config", `${SAVED}/`, `--claude-config=${VLLM}`], config, add.d)).toBe(0);
		expect(add.d.writeConfig).toHaveBeenCalledWith({ ...config, claudeConfigDirs: { repo: [SAVED, VLLM] } });
		expect(add.out).toContain(`repo: Claude config folders kept in the broker config: ${SAVED}, ${VLLM}`);
		expect(add.pins[0]).toBe(`${SAVED}|-`);
		const sync = withFolders({});
		await agentCommand("sync", ["repo", "--claude-config", SAVED], { ...config, claudeConfigDirs: { repo: [SAVED] } }, sync.d);
		expect(sync.d.writeConfig).toHaveBeenCalledWith({ ...config, claudeConfigDirs: { repo: [SAVED] } });
	});

	it("refuses --claude-config without an absolute folder, without the agent named, or on the wrong command", async () => {
		const { d } = withFolders({});
		await expect(agentCommand("sync", ["--claude-config", SAVED], config, d)).rejects.toThrow(/needs the agent named/);
		await expect(agentCommand("sync", ["repo", "--claude-config", "rel/dir"], config, d)).rejects.toThrow(/takes an absolute folder/);
		await expect(agentCommand("sync", ["repo", "--claude-config"], config, d)).rejects.toThrow(/takes an absolute folder/);
		await expect(agentCommand("remove", ["repo", "--claude-config", SAVED], config, d)).rejects.toThrow(/only goes with agent add or agent sync/);
		await expect(agentCommand("list", ["--bogus"], config, d)).rejects.toThrow("unknown flag: --bogus");
		await expect(agentCommand("add", ["ghost", "--claude-config", SAVED], config, d)).rejects.toThrow(/does not exist/);
		await expect(agentCommand("add", ["Bad Name"], config, d)).rejects.toThrow(/not a valid agent user name/);
		expect(d.writeConfig).not.toHaveBeenCalled();
	});

	it("remove cleans every folder, skips the ones root won't use, and forgets the saved folders", async () => {
		const entry = JSON.stringify({ mcpServers: { github: mcpEntry("repo", DIR) } });
		const cfg = { ...config, claudeConfigDirs: { repo: [SAVED], glmtest: ["/y"] } };
		const { d, out, err, files } = withFolders({ [claude("repo")]: entry, [`${SEC}/.claude.json`]: entry }, {});
		const pinOk = d.mcpIO.pin;
		d.mcpIO.pin = (folder: string, uid: number, within?: string) => {
			if (folder === "/home/repo/.claude") throw new SkippedFolder("/home/repo/.claude is a symlink or not a directory");
			if (folder === VLLM) return undefined;
			return pinOk(folder, uid, within);
		};
		expect(await agentCommand("remove", ["repo"], cfg, d)).toBe(0);
		expect(JSON.parse(files[`${SEC}/.claude.json`]).mcpServers).toEqual({});
		expect(out).toContain(`repo: removed the broker entry from ${SEC}/.claude.json (backup: .claude.json.gh-broker.bak)`);
		expect(out.join("\n")).not.toContain(VLLM);
		expect(out.join("\n")).not.toContain(SAVED); // a saved folder without a file is skipped quietly
		expect(err).toEqual(["repo: skipped /home/repo/.claude is a symlink or not a directory"]);
		expect(d.writeConfig).toHaveBeenCalledWith({ ...cfg, claudeConfigDirs: { glmtest: ["/y"] } });
		expect(out).toContain("repo: saved Claude config folders removed from the broker config");
	});

	it("remove reports a folder it can't clean and a config it can't write, and carries on", async () => {
		const boom = withFolders({}, { pin: (folder: string) => { if (folder === VLLM) throw new Error("EACCES"); return undefined; }, });
		boom.d.writeConfig = () => { throw new Error("EROFS"); };
		expect(await agentCommand("remove", ["repo"], { ...config, claudeConfigDirs: { repo: [SAVED] } }, boom.d)).toBe(0);
		expect(boom.err).toContain(`repo: could not remove the broker entry from ${VLLM}/.claude.json: EACCES. The agent is unregistered anyway; remove the entry by hand.`);
		expect(boom.err).toContain("repo: could not update the broker config: EROFS. Remove claudeConfigDirs.repo from it by hand.");
		const none = withFolders({});
		await agentCommand("remove", ["repo"], config, none.d);
		expect(none.d.writeConfig).not.toHaveBeenCalled();
	});

	it("list shows the other folders' status after the home one", async () => {
		const { d, out } = withFolders({ [claude("repo")]: JSON.stringify({ mcpServers: { github: mcpEntry("repo", DIR) } }) }, {
			pin: (folder: string) => {
				if (folder === VLLM) throw new SkippedFolder(`${VLLM} is outside the agent's home directory`);
				if (folder === "/home/repo/.claude") throw new Error("EIO");
				return { io: ok({ [`${SEC}/.claude.json`]: JSON.stringify({ mcpServers: { github: OLD } }) }), close: () => {} };
			}
		});
		await agentCommand("list", [], config, d);
		expect(out.find((l: string) => l.startsWith("repo "))).toBe(`repo  /run/gh-broker/agents/repo.sock  socket: yes  mcp: ok (/home/repo/.claude: can't read (EIO), ${SEC}: points elsewhere, ${VLLM}: skipped (${VLLM} is outside the agent's home directory))`);
	});
});
