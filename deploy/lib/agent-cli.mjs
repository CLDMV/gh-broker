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
import { applyMcpConfig, mcpEntry, mcpFileStatus, removeMcpConfig, UnsafeFile, MCP_BACKUP, MCP_FILE } from "./mcp-config.mjs";
import { statePathOf } from "./otp-cli.mjs";
import { spendRecentCodes, withoutUser } from "./otp.mjs";

/** Run one `agent` subcommand. Returns the exit code; throws on a failure the dispatcher reports. */
export async function agentCommand(command, rest, config, d) {
	const flags = rest.filter((a) => a.startsWith("-"));
	const names = rest.filter((a) => !a.startsWith("-"));
	const noMcp = flags.includes("--no-mcp-config");
	if (command === "list") return list(config, d);
	if (command === "sync") return sync(config, names[0], noMcp, d);
	if (names.length !== 1) throw new Error(`name the agent user: sudo gh-broker agent ${command} <user>`);
	return command === "add" ? add(config, names[0], noMcp, d) : remove(config, names[0], d);
}

const registry = (d) => registeredAgents(d.groups());

/**
 * The agent's Claude config folders other than the home directory: its `~/.claude*` folders and
 * the `CLAUDE_CONFIG_DIR` of its running `claude` sessions (#163). Only these users' own folders
 * are looked at, never anyone else's.
 */
function extraFolders(info, d) {
	const found = [...(d.mcpIO.scan?.(info.home) ?? []), ...(d.mcpIO.sessions?.(info.uid) ?? [])];
	return [...new Set(found)].filter((f) => f !== info.home);
}

/**
 * Run `fn(io)` for the files in `folder`. The home directory uses the io as is; any other folder is
 * pinned first (it must be a real directory the agent owns). Returns undefined when the folder is gone.
 */
function inFolder(folder, info, d, fn) {
	if (folder === info.home || !d.mcpIO.pin) return fn(d.mcpIO);
	const pinned = d.mcpIO.pin(folder, info.uid);
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
	const home = configureFolder(user, info.home, info, dir, entry, d);
	let worst = home;
	for (const folder of extraFolders(info, d)) {
		const r = configureFolder(user, folder, info, dir, entry, d);
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
function configureFolder(user, folder, info, dir, entry, d) {
	const isHome = folder === info.home;
	const file = isHome ? "the user's ~/.claude.json" : `${folder}/${MCP_FILE}`;
	const where = isHome ? "" : ` in ${folder}/${MCP_FILE}`;
	let r;
	try {
		r = inFolder(folder, info, d, (io) => applyMcpConfig({ folder, user, dir, owner: { uid: info.uid, gid: info.gid }, create: isHome }, io)) ?? { status: "no-file" };
	} catch (err) {
		// Root is working in a folder the agent owns, so a write can fail on anything the agent puts
		// in the way (a directory where the backup goes, a symlinked folder). Report it; it must not
		// stop the caller.
		const reason = err instanceof UnsafeFile ? `${err.message}, so it was left alone` : `could not write the MCP config${where}: ${err.message}`;
		d.error(`${user}: ${reason}. Add this under "mcpServers" in ${file} by hand:`);
		d.log(JSON.stringify({ github: entry }, null, "\t"));
		return err instanceof UnsafeFile ? "unsafe" : "failed";
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

async function add(config, user, noMcp, d) {
	assertAgentName(user);
	if (!d.userInfo(user)) throw new Error(`user "${user}" does not exist; create it first (the installer can: sudo gh-broker install --agent-user ${user} --create-agent-user)`);
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
		for (const folder of [info.home, ...extraFolders(info, d)]) {
			const isHome = folder === info.home;
			try {
				const r = inFolder(folder, info, d, (io) => removeMcpConfig({ folder, dir, uid: info.uid }, io));
				if (!r || (!isHome && r.status === "no-file")) continue;
				const what = { removed: `removed the broker entry from ${r.path} (backup: ${MCP_BACKUP})`, absent: `no broker entry in ${r.path}`, "no-file": `no ${MCP_FILE} to edit`, unreadable: `${r.path} is not valid JSON, so it was left alone`, unsafe: `${r.reason}, so it was left alone` };
				d.log(`${user}: ${what[r.status]}`);
			} catch (err) {
				d.error(`${user}: could not remove the broker entry from ${folder}/${MCP_FILE}: ${err.message}. The agent is unregistered anyway; remove the entry by hand.`);
			}
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
			for (const folder of extraFolders(info, d)) {
				let status;
				try {
					status = inFolder(folder, info, d, (io) => mcpFileStatus({ folder, user: a.user, dir, uid: info.uid, ifAbsent: null }, io));
				} catch (err) {
					status = err instanceof UnsafeFile ? `unsafe (${err.message})` : `can't read (${err.message})`;
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
