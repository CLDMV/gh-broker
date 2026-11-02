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
 * and an entry in the agent user's Claude Code MCP config. Every effect is injected.
 */
import { agentGroup, agentsDir, assertAgentName, registeredAgents, socketPath, versionWarning } from "./agents.mjs";
import { applyMcpConfig, mcpEntry, mcpFileStatus, removeMcpConfig, MCP_BACKUP, MCP_FILE } from "./mcp-config.mjs";
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
	const r = applyMcpConfig({ home: info.home, user, dir, owner: { uid: info.uid, gid: info.gid } }, d.mcpIO);
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
	d.log(`${user}: restart the user's running Claude sessions to pick it up. If a running session overwrites the file, "sudo gh-broker agent sync ${user}" puts it back.`);
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
	const info = d.userInfo(user);
	if (info) {
		const r = removeMcpConfig({ home: info.home, dir: agentsDir(config.listen), uid: info.uid }, d.mcpIO);
		const what = { removed: `removed the broker entry from ${r.path} (backup: ${MCP_BACKUP})`, absent: `no broker entry in ${r.path}`, "no-file": `no ${MCP_FILE} to edit`, unreadable: `${r.path} is not valid JSON, so it was left alone`, unsafe: `${r.reason}, so it was left alone` };
		d.log(`${user}: ${what[r.status]}`);
	}
	d.removeGroup(user);
	d.log(`${user}: group ${agentGroup(user)} removed`);
	const statePath = statePathOf(config);
	const read = d.readState(statePath);
	if (read.status === "ok" && Object.hasOwn(read.state.users, user)) {
		d.writeState(statePath, spendRecentCodes(withoutUser(read.state, user), d.now()));
		d.log(`${user}: cleared from ${statePath}`);
	} else if (read.status === "corrupt") {
		d.error(`${statePath} is corrupt, so ${user}'s entry was not cleared; run "sudo gh-broker otp unlock --all"`);
	}
	d.restart();
	d.log("service restarted");
	return 0;
}

function list(config, d) {
	const dir = agentsDir(config.listen);
	const agents = registry(d);
	if (agents.length === 0) d.log("no agents registered (add one with: sudo gh-broker agent add <user>)");
	for (const a of agents) {
		const sock = socketPath(dir, a.user);
		const info = d.userInfo(a.user);
		const mcp = info ? mcpFileStatus({ home: info.home, user: a.user, dir, uid: info.uid }, d.mcpIO) : "no such user";
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
	for (const user of only ? [only] : agents) configureMcp(user, config, d, { noMcp });
	return 0;
}
