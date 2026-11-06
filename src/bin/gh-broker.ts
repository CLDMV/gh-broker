#!/usr/bin/env node
/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/bin/gh-broker.ts
 *	@Date: 2026-11-01T20:43:03-08:00 (1793594583)
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
 * The `gh-broker` command (the package `bin`, built to bin/gh-broker.mjs): `gh-broker install`,
 * `gh-broker otp ...` and `gh-broker agent ...`. `install` is the installer (src/cli/install.ts);
 * the rest is src/cli/cli.ts with the real effects from src/cli/real-deps.ts.
 */
import { runCli } from "../cli/cli.ts";
import { install } from "../cli/install.ts";
import { realDeps } from "../cli/real-deps.ts";

const argv = process.argv.slice(2);
if (argv[0] === "install") await install(argv.slice(1));
else process.exitCode = await runCli(argv, realDeps());
