/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /deploy/lib/agent-cli.mjs
 *	@Date: 2026-11-02T09:12:00-08:00 (1793639520)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-02T09:12:00-08:00 (1793639520)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * `gh-broker agent add | remove | list | sync` (#143, contract v2). An agent is a Linux group
 * `gh-broker-agent-<u>` (the registry), one socket per agent in the daemon's agents directory,
 * and an entry in the agent user's Claude Code MCP config: `~/.claude.json`, plus the
 * `.claude.json` in each other Claude config folder the user has (#163). Every effect is injected.
 */
import { agentGroup, agentsDir, assertAgentName, registeredAgents, socketPath, versionWarning } from "./agents.mjs";
import { applyMcpConfig, mcpEntry, mcpFileStatus, removeMcpConfig, SkippedFolder, MCP_BACKUP, MCP_FILE } from "./mcp-config.mjs";
import { statePathOf } from "./otp-cli.mjs";
import { absoluteFolders, addClaudeConfigDirs } from "./config-merge.mjs";
import { spendRecentCodes, withoutUser } from "./otp.mjs";

/** Run one `agent` subcommand. Returns the exit code; throws on a failure the dispatcher reports. */
export async function agentCommand(command, rest, config, d) {
	const { names, noMcp, claudeConfigs } = parseAgentArgs(rest);
	if (claudeConfigs.length && !["add", "sync"].includes(command)) throw new Error("--claude-config only goes with agent add or agent sync");
	if (command === "list") return list(config, d);
	if (command === "sync") {
		if (claudeConfigs.length && names.length !== 1) throw new Error("--claude-config needs the agent named: sudo gh-broker agent sync <user> --claude-config <dir>");
		if (claudeConfigs.length) {
			assertAgentName(names[0]);
			if (!registry(d).some((a) => a.user === names[0])) throw new Error(`"${names[0]}" is not a registered agent`);
			config = rememberFolders(config, names[0], claudeConfigs, d);
		}
		return sync(config, names[0], noMcp, d);
	}
	if (names.length !== 1) throw new Error(`name the agent user: sudo gh-broker agent ${command} <user>`);
	if (command === "add") {
		assertAgentName(names[0]);
		if (!d.userInfo(names[0])) throw new Error(`user "${names[0]}" does not exist; create it first (the installer can: sudo gh-broker install --agent-user ${names[0]} --create-agent-user)`);
		if (claudeConfigs.length) config = rememberFolders(config, names[0], claudeConfigs, d);
		return add(config, names[0], noMcp, d);
	}
	return remove(config, names[0], d);
}

/** Split `agent` arguments into names and flags; `--claude-config <dir>` (or `=<dir>`) is repeatable. */
function parseAgentArgs(rest) {
	const names = [];
	const claudeConfigs = [];
	let noMcp = false;
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--no-mcp-config") noMcp = true;
		else if (a === "--claude-config" || a.startsWith("--claude-config=")) {
			const dir = a === "--claude-config" ? rest[++i] : a.slice("--claude-config=".length);
			if (!dir?.startsWith("/")) throw new Error("--claude-config takes an absolute folder: --claude-config /path/to/claude-config");
			claudeConfigs.push(dir.replace(/(.)\/+$/, "$1"));
		} else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
		else names.push(a);
	}
	return { names, noMcp, claudeConfigs };
}

/** Add `dirs` to `user`'s saved Claude config folders and write the broker config. Returns the new config. */
function rememberFolders(config, user, dirs, d) {
	const next = { ...config, claudeConfigDirs: addClaudeConfigDirs(config.claudeConfigDirs, { [user]: dirs }) };
	d.writeConfig(next);
	d.log(`${user}: Claude config folders kept in the broker config: ${next.claudeConfigDirs[user].join(", ")}`);
	return next;
}

const registry = (d) => registeredAgents(d.groups());

/**
 * The agent's Claude config folders other than the home directory (#163): the ones saved for it
 * with --claude-config, its `~/.claude*` folders, and the `CLAUDE_CONFIG_DIR` of its running
 * `claude` sessions. Only these users' own folders are looked at, never anyone else's. Saved
 * folders were named by root, so they may be outside the home directory; found ones may not.
 * @returns {Array<{ folder: string, saved: boolean }>}
 */
function extraFolders(info, d, config, user) {
	const home = info.home.replace(/\/+$/, "");
	const saved = absoluteFolders(config.claudeConfigDirs?.[user]);
	const found = [...(d.mcpIO.scan?.(info.home) ?? []), ...(d.mcpIO.sessions?.(info.uid) ?? [])];
	const seen = new Set([home, info.home]);
	const out = [];
	for (const [list, isSaved] of [[saved, true], [found, false]]) {
		for (const folder of list) {
			if (seen.has(folder)) continue;
			seen.add(folder);
			out.push({ folder, saved: isSaved });
		}
	}
	return out;
}

/**
 * Run `fn(io)` for the files in `folder`. The home directory uses the io as is; any other folder is
 * pinned first (it must be a real directory the agent owns, and unless it was saved with
 * --claude-config, inside the agent's home). Returns undefined when the folder is gone.
 */
function inFolder({ folder, saved }, info, d, fn) {
	if (folder === info.home || !d.mcpIO.pin) return fn(d.mcpIO);
	const pinned = d.mcpIO.pin(folder, info.uid, saved ? undefined : info.home);
	if (!pinned) return undefined;
	try {
		return fn(pinned.io);
	} finally {
		pinned.close();
	}
}

const BAD = ["failed", "unsafe", "unreadable"];

/**
 * Write (or, with `noMcp`, just print) one agent's MCP config and explain the restart. Shared with
 * the installer. Returns the lines it logged through `d.log`.
 */
export function configureMcp(user, config, d, { noMcp = false } = {}) {
	const dir = agentsDir(config.listen);
	const entry = mcpEntry(user, dir);
	const info = d.userInfo(user);
	if (noMcp || !info) {
		d.log(`${user}: not writing the MCP config${info ? " (--no-mcp-config)" : " (no such user)"}. Add this under "mcpServers" in the user's ~/.claude.json:`);
		d.log(JSON.stringify({ github: entry }, null, "\t"));
		return "skipped";
	}
	const home = configureFolder(user, { folder: info.home, saved: false }, info, dir, entry, d);
	let worst = home;
	for (const place of extraFolders(info, d, config, user)) {
		const r = configureFolder(user, place, info, dir, entry, d);
		if (BAD.includes(r) && !BAD.includes(worst)) worst = r;
	}
	d.log(`${user}: restart the user's running Claude sessions to pick it up. If a running session overwrites the file, "sudo gh-broker agent sync ${user}" puts it back.`);
	return worst;
}

/**
 * Write the entry in one folder's `.claude.json` and log the outcome. The home directory's file is
 * created when missing; another folder is only updated when it already has one, since Claude
 * Code writes that file itself in any folder it uses.
 */
function configureFolder(user, place, info, dir, entry, d) {
	const { folder } = place;
	const isHome = folder === info.home;
	const file = isHome ? "the user's ~/.claude.json" : `${folder}/${MCP_FILE}`;
	const where = isHome ? "" : ` in ${folder}/${MCP_FILE}`;
	let r;
	try {
		r = inFolder(place, info, d, (io) => applyMcpConfig({ folder, user, dir, owner: { uid: info.uid, gid: info.gid }, create: isHome }, io)) ?? { status: "no-file" };
	} catch (err) {
		if (err instanceof SkippedFolder) {
			d.error(`${user}: skipped ${err.message}`);
			return "skipped";
		}
		// Root is working in a folder the agent owns, so a write can fail on anything the agent puts
		// in the way (a directory where the backup goes). Report it; it must not stop the caller.
		d.error(`${user}: could not write the MCP config${where}: ${err.message}. Add this under "mcpServers" in ${file} by hand:`);
		d.log(JSON.stringify({ github: entry }, null, "\t"));
		return "failed";
	}
	if (r.status === "no-file") return "no-file";
	if (r.status === "unsafe") {
		d.error(`${user}: ${r.reason}, so it was left alone (root won't read or replace it). Make it a plain file the user owns and run "sudo gh-broker agent sync ${user}", or add this under "mcpServers" by hand:`);
		d.log(JSON.stringify({ github: entry }, null, "\t"));
		return "unsafe";
	}
	if (r.status === "unreadable") {
		d.log(`${user}: ${r.path} is not valid JSON, so it was left alone. Add this under "mcpServers" by hand:`);
		d.log(JSON.stringify({ github: entry }, null, "\t"));
		return "unreadable";
	}
	d.log(`${user}: MCP config ${r.status === "unchanged" ? "already up to date" : r.status} in ${r.path} (entry "${r.key}")${r.status === "written" ? `; previous file saved as ${MCP_BACKUP}` : ""}`);
	return r.status;
}

/** Smoke-test one agent's socket; logs the result and returns whether it answered. */
export async function smokeAgent(user, config, d) {
	const sock = socketPath(agentsDir(config.listen), user);
	try {
		const r = await d.smoke(sock);
		d.log(`${user}: broker answered on ${sock} (${r.tools.length} tools)`);
		return true;
	} catch (err) {
		d.error(`${user}: smoke test failed on ${sock}: ${err.message}\n  check: journalctl -u gh-broker -n 30 --no-pager`);
		return false;
	}
}

/** `user` is a valid name and an existing user (agentCommand checks both before it saves anything). */
async function add(config, user, noMcp, d) {
	d.ensureGroup(user);
	d.log(`${user}: registered (group ${agentGroup(user)})`);
	configureMcp(user, config, d, { noMcp });
	d.restart();
	return (await smokeAgent(user, config, d)) ? 0 : 1;
}

function remove(config, user, d) {
	assertAgentName(user);
	if (!registry(d).some((a) => a.user === user)) throw new Error(`"${user}" is not a registered agent`);
	// The group and the restart go first: they are what close the agent's socket, so nothing the
	// agent can do to its own home directory (which the MCP cleanup below edits) can stop that.
	d.removeGroup(user);
	d.log(`${user}: unregistered (group ${agentGroup(user)} emptied; it is kept so its id is never given to another agent)`);
	d.restart();
	d.log("service restarted");
	const info = d.userInfo(user);
	if (info) {
		const dir = agentsDir(config.listen);
		for (const place of [{ folder: info.home, saved: false }, ...extraFolders(info, d, config, user)]) {
			const { folder } = place;
			const isHome = folder === info.home;
			try {
				const r = inFolder(place, info, d, (io) => removeMcpConfig({ folder, dir, uid: info.uid }, io));
				if (!r || (!isHome && r.status === "no-file")) continue;
				const what = { removed: `removed the broker entry from ${r.path} (backup: ${MCP_BACKUP})`, absent: `no broker entry in ${r.path}`, "no-file": `no ${MCP_FILE} to edit`, unreadable: `${r.path} is not valid JSON, so it was left alone`, unsafe: `${r.reason}, so it was left alone` };
				d.log(`${user}: ${what[r.status]}`);
			} catch (err) {
				if (err instanceof SkippedFolder) {
					d.error(`${user}: skipped ${err.message}`);
					continue;
				}
				d.error(`${user}: could not remove the broker entry from ${folder}/${MCP_FILE}: ${err.message}. The agent is unregistered anyway; remove the entry by hand.`);
			}
		}
	}
	if (config.claudeConfigDirs?.[user]) {
		try {
			const { [user]: _gone, ...rest } = config.claudeConfigDirs;
			d.writeConfig({ ...config, claudeConfigDirs: rest });
			d.log(`${user}: saved Claude config folders removed from the broker config`);
		} catch (err) {
			d.error(`${user}: could not update the broker config: ${err.message}. Remove claudeConfigDirs.${user} from it by hand.`);
		}
	}
	try {
		const statePath = statePathOf(config);
		const read = d.readState(statePath);
		if (read.status === "ok" && Object.hasOwn(read.state.users, user)) {
			d.writeState(statePath, spendRecentCodes(withoutUser(read.state, user), d.now()));
			d.log(`${user}: cleared from ${statePath}`);
		} else if (read.status === "corrupt") {
			d.error(`${statePath} is corrupt, so ${user}'s entry was not cleared; run "sudo gh-broker otp unlock --all"`);
		}
	} catch (err) {
		// The agent is already unregistered and its socket closed; a leftover entry is harmless.
		d.error(`${user}: lock state not cleared: ${err.message}. "sudo gh-broker otp unlock ${user}" clears it later.`);
	}
	return 0;
}

function list(config, d) {
	const dir = agentsDir(config.listen);
	const agents = registry(d);
	if (agents.length === 0) d.log("no agents registered (add one with: sudo gh-broker agent add <user>)");
	for (const a of agents) {
		const sock = socketPath(dir, a.user);
		const info = d.userInfo(a.user);
		let mcp = "no such user";
		if (info) {
			try {
				mcp = mcpFileStatus({ folder: info.home, user: a.user, dir, uid: info.uid }, d.mcpIO);
			} catch (err) {
				mcp = `can't read (${err.message})`; // one agent's file must not hide the others
			}
			const others = [];
			for (const place of extraFolders(info, d, config, a.user)) {
				const { folder } = place;
				let status;
				try {
					status = inFolder(place, info, d, (io) => mcpFileStatus({ folder, user: a.user, dir, uid: info.uid, ifAbsent: null }, io));
				} catch (err) {
					status = err instanceof SkippedFolder ? `skipped (${err.message})` : `can't read (${err.message})`;
				}
				if (status) others.push(`${folder}: ${status}`);
			}
			if (others.length) mcp += ` (${others.join(", ")})`;
		}
		d.log(`${a.user}  ${sock}  socket: ${d.socketExists(sock) ? "yes" : "no"}  mcp: ${mcp}${a.complete ? "" : "  (group members incomplete; run agent add)"}`);
	}
	const warn = versionWarning(d.versions().pkg, d.versions().deployed);
	if (warn) d.error(warn);
	return 0;
}

function sync(config, only, noMcp, d) {
	const agents = registry(d).map((a) => a.user);
	if (only) {
		assertAgentName(only);
		if (!agents.includes(only)) throw new Error(`"${only}" is not a registered agent`);
	}
	let ok = true;
	for (const user of only ? [only] : agents) if (BAD.includes(configureMcp(user, config, d, { noMcp }))) ok = false;
	return ok ? 0 : 1;
}
