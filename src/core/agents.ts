/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/core/agents.ts
 *	@Date: 2026-11-01T21:30:00-08:00 (1793597400)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T13:28:37-08:00 (1794691717)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The agent-user name rules (design #175 §1's agents.ts split row): what names can be an
 * agent user. The registry itself — groups, sockets, /etc/group parsing — is the daemon's
 * (src/agents.ts), which re-exports these.
 */

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
