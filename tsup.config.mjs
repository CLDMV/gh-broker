/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /tsup.config.mjs
 *	@Date: 2026-11-05T22:59:09-08:00 (1793948349)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-05T23:01:04-08:00 (1793948464)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Bundler config — produces the published dist/index.mjs from src/index.ts.
 *
 * The installer copies only dist/ into /opt/gh-broker (no node_modules there), so the
 * bundle must be self-contained: every runtime dependency is inlined (`noExternal`).
 *
 * gh-broker is a service, not a library, so there is no CJS shim and no second entry.
 *
 * Sourcemaps are generated for local debugging but kept out of the published tarball by
 * the `!dist/**\/*.map` negation in package.json `files`.
 */
import { defineConfig } from "tsup";

export default defineConfig({
	entry: { index: "src/index.ts" },
	outDir: "dist",
	format: ["esm"],
	platform: "node",
	target: "node22",
	splitting: false,
	sourcemap: true,
	dts: false,
	minify: true,
	keepNames: true,
	removeNodeProtocol: false,
	noExternal: [/./],
	clean: true,
	outExtension() {
		return { js: ".mjs" };
	}
});
