/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /tsup.config.mjs
 *	@Date: 2026-11-05T22:59:09-08:00 (1793948349)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-06T06:12:20-08:00 (1793974340)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Bundler config — produces the published dist/index.mjs (the daemon) from
 * src/index.ts and bin/gh-broker.mjs (the `gh-broker` command) from src/bin/gh-broker.ts.
 *
 * The installer copies only dist/ into /opt/gh-broker (no node_modules there), so the
 * daemon bundle must be self-contained: every runtime dependency is inlined (`noExternal`).
 * The command runs from the installed package, next to its node_modules, so it keeps the
 * package's dependencies external like any other CLI.
 *
 * gh-broker is a service, not a library, so there is no CJS shim.
 *
 * Sourcemaps are generated for local debugging but kept out of the published tarball by
 * the `!dist/**\/*.map` and `!bin/**\/*.map` negations in package.json `files`.
 */
import { defineConfig } from "tsup";

const shared = {
	format: ["esm"],
	platform: "node",
	target: "node22",
	splitting: false,
	sourcemap: true,
	dts: false,
	minify: true,
	keepNames: true,
	removeNodeProtocol: false,
	outExtension() {
		return { js: ".mjs" };
	}
};

export default defineConfig([
	{ ...shared, entry: { index: "src/index.ts" }, outDir: "dist", noExternal: [/./], clean: true },
	{ ...shared, entry: { "gh-broker": "src/bin/gh-broker.ts" }, outDir: "bin", clean: true }
]);
