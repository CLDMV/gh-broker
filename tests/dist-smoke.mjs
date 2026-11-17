/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /tests/dist-smoke.mjs
 *	@Date: 2026-11-16T17:07:22-08:00 (1794877642)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-16T17:10:30-08:00 (1794877830)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Runs the built bundles once, so a bundle that can't even load fails the build
 * instead of an install. v0.11.0 shipped a dist/index.mjs whose inlined CommonJS dependency
 * called require("fs") and crashed at startup, while every unit test passed against src/.
 *
 * It also fails if the daemon bundle still holds a dynamic require(), the shape of that crash.
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
} catch (err) {
	console.error(`dist smoke test failed: ${err.stderr || err.message}`);
	process.exitCode = 1;
} finally {
	rmSync(isolated, { recursive: true, force: true });
}
if (process.exitCode === 1) process.exit(1);
console.log("dist smoke test: dist/index.mjs and bin/gh-broker.mjs load");
