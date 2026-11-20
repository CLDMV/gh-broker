/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/invoke.ts
 *	@Date: 2026-11-14T13:11:15-08:00 (1794690675)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-19T16:59:26-08:00 (1795136366)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

// invoke moved to src/core/invoke.ts (design #175 slice 4b: the library lives in src/core/);
// re-exported here so the old import path keeps working.
export * from "./core/invoke.ts";
