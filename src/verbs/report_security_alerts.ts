/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/report_security_alerts.ts
 *	@Date: 2026-07-07T00:24:51-07:00 (1783409091)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T15:02:53-08:00 (1794697373)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The report_security_alerts verb moved whole to the library half (src/core/verbs/report_security_alerts.ts, design #175
 * §1's verbs row); this shim re-exports it so the old import path keeps working.
 */

export * from "../core/verbs/report_security_alerts.ts";
