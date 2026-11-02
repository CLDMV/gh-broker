/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/agents.ts
 *	@Date: 2026-11-01T21:30:00-08:00 (1793597400)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T21:30:00-08:00 (1793597400)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The agent registry. An agent user `<u>` is registered when the group `gh-broker-agent-<u>`
 * exists with exactly the members `gh-broker` and `<u>`. The broker gives each one its own
 * socket, `<dir>/<u>.sock`, owned by that group with mode 0660, so the socket a call arrives
 * on says who made it (Node can't read SO_PEERCRED).
 */

import { isAbsolute } from "node:path";

/** Agent user names: a Linux login name short enough that the group name fits in 32 characters. */
export const AGENT_USER = /^[a-z_][a-z0-9_-]{0,15}$/;

/**
 * Names that fit the pattern but are refused: "__proto__" is a special key in JS objects, and
 * root and the service user itself are never agents.
 */
export const RESERVED_AGENT_USERS: readonly string[] = ["__proto__", "root", "gh-broker"];

/** Whether `name` can be an agent user. */
export function isAgentUser(name: string): boolean {
	return AGENT_USER.test(name) && !RESERVED_AGENT_USERS.includes(name);
}

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
