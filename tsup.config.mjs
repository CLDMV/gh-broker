/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /tsup.config.mjs
 *	@Date: 2026-11-05T22:59:09-08:00 (1793948349)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-19T21:50:52-08:00 (1795153852)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Bundler config — produces the published dist/index.mjs (the daemon) from
 * src/index.ts, bin/gh-broker.mjs (the `gh-broker` command) from src/bin/gh-broker.ts,
 * dist/core/index.mjs (the library subpath, §6) from src/core/index.ts, and the
 * library's bundled types in types/ (a dts-only build of the same entry).
 *
 * The installer copies only dist/ into /opt/gh-broker (no node_modules there), so the
 * daemon bundle must be self-contained: every runtime dependency is inlined (`noExternal`).
 * The command runs from the installed package, next to its node_modules, so it keeps the
 * package's dependencies external like any other CLI. The library bundle keeps them
 * external for the same reason — a consumer resolves them from their own node_modules;
 * only the daemon bundle inlines.
 *
 * Nothing cleans a directory another config writes: tsup runs the array's configs
 * CONCURRENTLY (Promise.all), so package.json's prebuild wipes dist/, types/ and bin/
 * ONCE up front and every config below runs clean: false. The daemon ships as
 * dist/index.mjs (the path the service's ExecStart runs); dist/core/ is the library
 * (excluded from the /opt deploy — its imports are external).
 *
 * Sourcemaps are generated for local debugging but kept out of the published tarball by
 * the `!dist/**\/*.map` and `!bin/**\/*.map` negations in package.json `files`.
 */
import { copyFileSync } from "node:fs";
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
	{ ...shared, entry: { index: "src/index.ts" }, outDir: "dist", noExternal: [/./], clean: false },
	{ ...shared, entry: { "gh-broker": "src/bin/gh-broker.ts" }, outDir: "bin", clean: false },
	// The library subpath (§6): dependencies stay external (tsup's default — the
	// package's `dependencies`, unlike the daemon's noExternal above).
	// src/core/index.cjs (the generic CommonJS shim) is copied verbatim next to the built
	// entry, where its require("./index.mjs") resolves. It is never compiled or bundled.
	{
		...shared,
		entry: { "core/index": "src/core/index.ts" },
		outDir: "dist",
		clean: false,
		onSuccess: async () => copyFileSync("src/core/index.cjs", "dist/core/index.cjs")
	},
	// The library's types (§6): a dedicated dts-only build of the same barrel → types/.
	// `dts: { only: true }` is the config-file form of --dts-only (the `dtsOnly` flag is
	// CLI-only); a bare `dts: true` would skip the build entirely here.
	{ ...shared, dts: { only: true }, entry: { index: "src/core/index.ts" }, outDir: "types/core", sourcemap: false, clean: false }
]);
