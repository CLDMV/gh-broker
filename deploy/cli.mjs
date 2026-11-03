#!/usr/bin/env node
/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /deploy/cli.mjs
 *	@Date: 2026-11-01T20:43:03-08:00 (1793594583)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T20:43:03-08:00 (1793594583)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The `gh-broker` command (the package `bin`): `gh-broker install`, `gh-broker otp ...` and
 * `gh-broker agent ...`. `install` hands over to the installer (deploy/install.mjs); the rest is
 * lib/cli.mjs with the real effects from real-deps.mjs.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCli } from "./lib/cli.mjs";
import { realDeps } from "./real-deps.mjs";

/** Run the CLI with the real effects and set the exit code. `install` is the installer. */
export async function main(argv = process.argv.slice(2)) {
	if (argv[0] === "install") {
		process.argv.splice(2, 1); // the installer reads its flags from argv[2..]
		await import("./install.mjs");
		return;
	}
	process.exitCode = await runCli(argv, realDeps());
}

// npm links the bin as a symlink, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
