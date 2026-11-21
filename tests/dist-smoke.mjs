/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /tests/dist-smoke.mjs
 *	@Date: 2026-11-16T17:07:22-08:00 (1794877642)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-19T19:50:30-08:00 (1795146630)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Runs the built bundles once, so a bundle that can't even load fails the build
 * instead of an install. v0.11.0 shipped a dist/index.mjs whose inlined CommonJS dependency
 * called require("fs") and crashed at startup, while every unit test passed against src/.
 *
 * It also fails if the daemon bundle still holds a dynamic require(), the shape of that crash,
 * and — since the library subpath landed (§6) — if the built core bundle doesn't load with its
 * public entry surface on it, from ESM (the exports map's "." and "./core") or through a CJS
 * consumer's require() (require(esm); the core has no top-level await to block it).
 *
 * Usage: node tests/dist-smoke.mjs (run by `npm run build` after tsup).
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (file, args) => execFileSync(process.execPath, [file, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
// The installer copies only dist/ into /opt/gh-broker, with no node_modules beside it, so run
// the daemon from a copy that has nothing to resolve packages from.
const isolated = join(root, "tmp", "dist-smoke");

try {
	// esbuild only emits its "Dynamic require of ... is not supported" shim when the bundle
	// still holds a require() it couldn't resolve, which throws in an ES module. qrcode was
	// one (#208); the daemon has no business carrying any.
	if (readFileSync(join(root, "dist", "index.mjs"), "utf8").includes("Dynamic require of")) throw new Error("dist/index.mjs still contains a dynamic require() of a CommonJS dependency");
	rmSync(isolated, { recursive: true, force: true });
	mkdirSync(isolated, { recursive: true });
	cpSync(join(root, "dist"), join(isolated, "dist"), { recursive: true });
	const paths = JSON.parse(run(join(isolated, "dist", "index.mjs"), ["--print-paths"]));
	if (typeof paths.config !== "string" || typeof paths.secrets !== "string") throw new Error(`dist/index.mjs --print-paths printed ${JSON.stringify(paths)}`);
	run(join(root, "bin", "gh-broker.mjs"), ["--help"]);
	// The library subpath (§6): dist/core/index.mjs keeps the package's dependencies
	// external, so it only loads from the package root (the isolated copy above has no
	// node_modules by design — that is the point of the daemon check). The public entry
	// surface must be on the barrel: the star-export that pulls invoke.ts in must not
	// have silently dropped a name to an ambiguity.
	const core = await import(join(root, "dist", "core", "index.mjs"));
	for (const name of ["createBroker", "InvokeError", "perCallUpstream", "buildCatalog", "parseConfigLib"]) {
		if (typeof core[name] !== "function") throw new Error(`dist/core/index.mjs is missing its public ${name} export`);
	}
	const broker = core.createBroker({ tools: [], owners: {} });
	if (typeof broker.invoke !== "function" || typeof broker.run !== "function") throw new Error("createBroker did not return its invoke/run entry");
	// A CJS consumer's require() of the core entry reaches the same ESM module via
	// require(esm) — the core has no top-level await, so the sync require works.
	execFileSync(process.execPath, ["-e", `const m = require(${JSON.stringify(join(root, "dist", "core", "index.mjs"))}); if (typeof m.createBroker !== "function" || typeof m.InvokeError !== "function" || typeof m.perCallUpstream !== "function") throw new Error("require(esm) of dist/core/index.mjs is missing the public entry surface")`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (err) {
	console.error(`dist smoke test failed: ${err.stderr || err.message}`);
	process.exitCode = 1;
} finally {
	rmSync(isolated, { recursive: true, force: true });
}
if (process.exitCode === 1) process.exit(1);
console.log("dist smoke test: dist/index.mjs, dist/core/index.mjs and bin/gh-broker.mjs load");
