/**
 * @fileoverview OOM-safe Vitest runner — delegates to @cldmv/vitest-runner, which
 * spawns each test file in its own child process and (under coverage) uses a
 * blob-per-file + `--mergeReports` strategy so a single process never holds
 * coverage for the whole suite.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "@cldmv/vitest-runner";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

const delimiter = argv.indexOf("--");
const forwarded = delimiter === -1 ? argv.filter((a) => a.startsWith("-")) : argv.slice(0, delimiter);
const testPatterns = delimiter === -1 ? argv.filter((a) => !a.startsWith("-")) : argv.slice(delimiter + 1);

const coverageQuiet = forwarded.includes("--coverage-quiet");
const coverage = coverageQuiet || forwarded.includes("--coverage");
const passthrough = forwarded.filter((a) => a !== "--coverage" && a !== "--coverage-quiet");

const parsedWorkers = parseInt(process.env.VITEST_WORKERS ?? "", 10);
const workers = Number.isInteger(parsedWorkers) && parsedWorkers > 0 ? parsedWorkers : 4;

const code = await run({
	cwd: root,
	testDir: "tests",
	vitestConfig: ".configs/vitest.config.mjs",
	testFilePattern: /\.test\.mts$/,
	testPatterns,
	workers,
	coverageQuiet,
	vitestArgs: [...(coverage ? ["--coverage"] : []), ...passthrough],
	nodeEnv: process.env.NODE_ENV || "development"
});
process.exit(code);
