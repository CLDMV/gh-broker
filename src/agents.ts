/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/agents.ts
 *	@Date: 2026-07-07T00:24:51-07:00 (1783409091)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T13:28:36-08:00 (1794691716)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The agent registry (the daemon's half of the split — design #175 §1's agents.ts row).
 * An agent user `<u>` is registered when the group `gh-broker-agent-<u>` exists with
 * exactly the members `gh-broker` and `<u>`. The broker gives each one its own socket,
 * `<dir>/<u>.sock`, owned by that group with mode 0660, so the socket a call arrives on
 * says who made it (Node can't read SO_PEERCRED). The name rules themselves
 * ({@link isAgentUser} and friends) are library vocabulary in src/core/agents.ts,
 * re-exported here so the old import path keeps working.
 */

import { isAbsolute } from "node:path";

import { AGENT_USER, RESERVED_AGENT_USERS, isAgentUser } from "./core/agents.ts";

export { AGENT_USER, RESERVED_AGENT_USERS, isAgentUser };

export const AGENT_GROUP_PREFIX = "gh-broker-agent-";

/** The broker's own service user, the other required member of every agent group. */
export const SERVICE_USER = "gh-broker";

export interface Agent {
	user: string;
	group: string;
	gid: number;
}

/** The directory of `listen: "agents:<abs dir>"`, or undefined when the value isn't that form. */
export function agentsDir(listen: string): string | undefined {
	if (!listen.startsWith("agents:")) return undefined;
	const dir = listen.slice("agents:".length);
	return isAbsolute(dir) ? dir : undefined;
}

/**
 * Registered agents from the text of /etc/group. A `gh-broker-agent-*` group whose name doesn't
 * hold a valid user name, or whose members aren't exactly gh-broker and that user, is skipped and
 * reported in `skipped` with the reason.
 */
export function parseAgentGroups(groupFile: string): { agents: Agent[]; skipped: string[] } {
	const agents: Agent[] = [];
	const skipped: string[] = [];
	for (const line of groupFile.split("\n")) {
		const [group, , gidText, memberText] = line.split(":");
		if (!group?.startsWith(AGENT_GROUP_PREFIX)) continue;
		const user = group.slice(AGENT_GROUP_PREFIX.length);
		const gid = Number(gidText);
		if (!isAgentUser(user)) {
			skipped.push(`${group}: "${user}" is not a valid agent user name`);
			continue;
		}
		if (!gidText || !Number.isSafeInteger(gid)) {
			skipped.push(`${group}: bad gid`);
			continue;
		}
		const members = new Set((memberText ?? "").split(",").map((m) => m.trim()).filter(Boolean));
		if (members.size !== 2 || !members.has(SERVICE_USER) || !members.has(user)) {
			skipped.push(`${group}: members must be exactly ${SERVICE_USER} and ${user}`);
			continue;
		}
		agents.push({ user, group, gid });
	}
	return { agents, skipped };
}
