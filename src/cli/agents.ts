/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/agents.ts
 *	@Date: 2026-11-02T09:12:00-08:00 (1793639520)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-06T06:12:13-08:00 (1793974333)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The agent registry and the small pure helpers around it (#143, contract v2). An agent user `<u>`
 * is registered when the group `gh-broker-agent-<u>` exists with exactly `gh-broker` and `<u>` as
 * members; the daemon listens on one socket per registered agent. Everything here works on text
 * (the contents of /etc/group, a `getent passwd` line), so it is testable without a host.
 */
import { join } from "node:path";

export const SVC_USER = "gh-broker";
export const AGENT_GROUP_PREFIX = "gh-broker-agent-";
export const LEGACY_CLIENTS_GROUP = "gh-broker-clients";
export const DEFAULT_AGENTS_DIR = "/run/gh-broker/agents";
export const DEFAULT_LISTEN = `agents:${DEFAULT_AGENTS_DIR}`;
/** Keeps `gh-broker-agent-<u>` within the 32-character group name limit. */
export const AGENT_NAME = /^[a-z_][a-z0-9_-]{0,15}$/;

/** Names that fit the pattern but are refused, as the daemon refuses them (src/agents.ts): a special JS key, root, and the service user. */
export const RESERVED_AGENT_NAMES = ["__proto__", "root", SVC_USER];

/** Whether `name` may be registered as an agent user. */
export function validAgentName(name: unknown): name is string {
	return typeof name === "string" && AGENT_NAME.test(name) && !RESERVED_AGENT_NAMES.includes(name);
}

/** Throws a clear error for an invalid agent user name. */
export function assertAgentName(name: unknown): string {
	if (!validAgentName(name)) throw new Error(`"${name}" is not a valid agent user name (lowercase letters, digits, "_" and "-", starting with a letter or "_", at most 16 characters)`);
	return name;
}

export const agentGroup = (user: string): string => `${AGENT_GROUP_PREFIX}${user}`;

/** The directory the agents' sockets live in, from `listen` ("agents:<abs dir>"). */
export function agentsDir(listen: unknown): string {
	return typeof listen === "string" && /^agents:\/.+/.test(listen) ? listen.slice("agents:".length) : DEFAULT_AGENTS_DIR;
}

export const socketPath = (dir: string, user: string): string => join(dir, `${user}.sock`);

/** One /etc/group entry. */
export interface Group {
	name: string;
	gid: number;
	members: string[];
}

/** One registered agent: its user, its group's gid, and whether the group has exactly the right members. */
export interface RegisteredAgent {
	user: string;
	gid: number;
	complete: boolean;
}

/** Parse the contents of /etc/group (or `getent group` output) into { name, gid, members }. */
export function parseGroups(text: string): Group[] {
	const groups: Group[] = [];
	for (const line of text.split("\n")) {
		const parts = line.split(":");
		if (parts.length < 4 || !parts[0]) continue;
		groups.push({ name: parts[0], gid: Number(parts[2]), members: parts[3] ? parts[3].split(",").filter(Boolean) : [] });
	}
	return groups;
}

/**
 * Every `gh-broker-agent-<u>` group, with whether it is complete: its members are exactly the
 * service user and `<u>`, the same test the daemon uses (it ignores a group that isn't). A group
 * with no members is a removed agent (see removeAgentGroup) and isn't listed.
 * @returns the agents, sorted by user
 */
export function registeredAgents(groups: Group[]): RegisteredAgent[] {
	const out: RegisteredAgent[] = [];
	for (const g of groups) {
		if (!g.name.startsWith(AGENT_GROUP_PREFIX)) continue;
		const user = g.name.slice(AGENT_GROUP_PREFIX.length);
		if (!validAgentName(user) || g.members.length === 0) continue;
		const members = new Set(g.members);
		out.push({ user, gid: g.gid, complete: members.size === 2 && members.has(SVC_USER) && members.has(user) });
	}
	return out.sort((a, b) => a.user.localeCompare(b.user));
}

/**
 * The agents to register on upgrade: members of the old shared `gh-broker-clients` group (other
 * than the service user) that are not registered yet. Members with an invalid name are returned
 * separately, to be reported and skipped.
 */
export function migrationPlan(groups: Group[], registered: RegisteredAgent[]): { add: string[]; skipped: string[] } {
	const clients = groups.find((g) => g.name === LEGACY_CLIENTS_GROUP);
	const have = new Set(registered.map((a) => a.user));
	const add: string[] = [];
	const skipped: string[] = [];
	for (const m of clients?.members ?? []) {
		if (m === SVC_USER || have.has(m)) continue;
		(validAgentName(m) ? add : skipped).push(m);
	}
	return { add, skipped };
}

/** Parse one `getent passwd` line into { uid, gid, home }, or undefined. */
export function parsePasswd(line: string): { uid: number; gid: number; home: string } | undefined {
	const f = line.trim().split(":");
	if (f.length < 6) return undefined;
	const uid = Number(f[2]);
	const gid = Number(f[3]);
	if (!Number.isInteger(uid) || !Number.isInteger(gid) || !f[5]) return undefined;
	return { uid, gid, home: f[5] };
}

/**
 * Where the installed package stands: a global install under /usr/local survives a Node upgrade,
 * one under an nvm version folder does not.
 */
export function classifyInstall(packageDir: string): "global" | "nvm" | "checkout" {
	if (/nvm\/versions\//.test(packageDir)) return "nvm";
	if (packageDir.startsWith("/usr/local/lib/node_modules/")) return "global";
	return "checkout";
}

/** A warning when the npm package and the deployed /opt copy differ, else undefined. */
export function versionWarning(pkgVersion: string | undefined, deployedVersion: string | undefined): string | undefined {
	if (!deployedVersion || !pkgVersion || pkgVersion === deployedVersion) return undefined;
	return `warning: the installed package is ${pkgVersion} but the deployed service is ${deployedVersion}; run "sudo gh-broker install"`;
}

export const NPM_INSTALL_COMMAND = "sudo npm install -g --prefix /usr/local --ignore-scripts @cldmv/gh-broker@latest";
