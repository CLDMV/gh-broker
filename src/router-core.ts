/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/router-core.ts
 *	@Date: 2026-11-14T00:00:00-08:00 (1794643200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T15:01:40-08:00 (1794697300)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The library-facing router core moved whole to src/core/router-core.ts (design #175
 * §1's router.ts split row — the dispatch layer built in slice 4); this shim re-exports
 * it (the Upstream/GhcrVerbs/RouteDeps seams and the dispatch functions) so the old
 * import path keeps working.
 */

export * from "./core/router-core.ts";
