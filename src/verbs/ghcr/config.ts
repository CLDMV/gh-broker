/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/ghcr/config.ts
 *	@Date: 2026-07-07T00:24:51-07:00 (1783409091)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T15:02:51-08:00 (1794697371)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The GHCR config module moved whole to the library half (src/core/verbs/ghcr/config.ts,
 * design #175 §1's verbs row); this shim re-exports it so the old import path keeps
 * working for the host ghcr files and the tests.
 */

export * from "../../core/verbs/ghcr/config.ts";
