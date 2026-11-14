/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/delete_branch.ts
 *	@Date: 2026-07-07T00:24:51-07:00 (1783409091)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T15:02:50-08:00 (1794697370)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The delete_branch verb moved whole to the library half (src/core/verbs/delete_branch.ts, design #175
 * §1's verbs row); this shim re-exports it so the old import path keeps working.
 */

export * from "../core/verbs/delete_branch.ts";
