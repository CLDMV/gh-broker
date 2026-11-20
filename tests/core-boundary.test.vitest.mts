/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /tests/core-boundary.test.vitest.mts
 *	@Date: 2026-11-14T13:55:00-08:00 (1794693300)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T13:55:00-08:00 (1794693300)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The library boundary guard (design #175 §1, slice 4b): nothing under src/core/ may
 * import from outside src/core/, except @cldmv/lib-otp, the package's declared runtime
 * dependencies, and node builtins. This is the purity check until the repo has a lint
 * script (#187) — it walks every .ts file under src/core/, resolves every relative
 * import, and classifies every bare specifier.
 *
 * There are no exceptions: every relative import under src/core/ resolves back into
 * src/core/ (the legacy catalog→otp/policy.ts edge died with slice 6's packaging re-cut,
 * which removed the SecretStore-compat shape along with its otpSetupProblem import).
 *
 * Pure re-export shims are treated as transparent: a relative import that lands outside
 * src/core/ passes when the target file consists only of `export ... from` statements
 * whose own targets resolve back into src/core/ (the old-path shims this slice left at
 * src/verbs/* and friends — they exist so the suite's tests keep importing, and
 * mocking, the old paths, and they add no host code to the library graph).
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = join(root, "src", "core");

/** Declared runtime dependencies of the package — the only bare specifiers core may import. */
const allowedNpm = new Set(Object.keys(pkg.dependencies));

/**
 * Relative imports allowed to leave src/core/, as "<file under src/core> -> <resolved
 * target under src/>". Empty since slice 6: the catalog's legacy-compat edge died with
 * the SecretStore-compat shape it served. The pin below keeps it that way.
 */
const allowedOutside = new Set<string>();

/**
 * Strips comments so prose like `told apart from "more than maxRepos"` can't read as an
 * import. A small state machine over the four string delimiters and the two comment
 * forms — enough for this codebase, which has no regex literals in core.
 */
function stripComments(source: string): string {
	let out = "";
	let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		const next = source[i + 1];
		if (state === "line") {
			if (c === "\n") {
				state = "code";
				out += c;
			}
			continue;
		}
		if (state === "block") {
			if (c === "*" && next === "/") {
				state = "code";
				i++;
			}
			continue;
		}
		if (state === "single" || state === "double" || state === "template") {
			// Inside a string: keep every character (the goal is only to not read comment
			// markers inside string literals), honouring escapes.
			const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
			out += c;
			if (c === "\\") {
				out += next ?? "";
				i++;
			} else if (c === quote) {
				state = "code";
			}
			continue;
		}
		// state === "code"
		if (c === "/" && next === "/") {
			state = "line";
			i++;
			continue;
		}
		if (c === "/" && next === "*") {
			state = "block";
			i++;
			continue;
		}
		if (c === "'") state = "single";
		else if (c === '"') state = "double";
		else if (c === "`") state = "template";
		out += c;
	}
	return out;
}

/** Every static + dynamic import specifier in a source file, comments excluded. */
function importedSpecifiers(source: string): string[] {
	const specs: string[] = [];
	for (const m of stripComments(source).matchAll(/(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*)["']([^"']+)["']/g)) {
		specs.push(m[1]);
	}
	return specs;
}

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(p);
		else if (entry.name.endsWith(".ts")) yield p;
	}
}

/** A src-root-relative path ("src/core/types.ts") for an absolute file path. */
function underRoot(file: string): string {
	return relative(root, file).split(sep).join("/");
}

/**
 * Whether `file` is a pure re-export shim: every non-blank, comment-free line is an
 * `export ... from "<spec>"` statement, and every spec resolves back into src/core/.
 * Such a file contributes no host code — it is a path alias for the module it
 * re-exports — so the boundary resolves through it instead of failing on it.
 */
function isPureCoreShim(file: string): boolean {
	const stripped = stripComments(readFileSync(file, "utf8"));
	const lines = stripped.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
	if (lines.length === 0) return false;
	for (const line of lines) {
		const m = /^export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\}|type\s*\{[^}]*\})\s*from\s*["']([^"']+)["'];?$/.exec(line);
		if (!m) return false;
		const target = relative(root, resolve(dirname(file), m[1])).split(sep).join("/");
		if (!target.startsWith("src/core/")) return false;
	}
	return true;
}

/** Resolves a relative import to its src-root-relative path, following pure core shims. */
function resolveRelative(fromFile: string, spec: string): string {
	let target = underRoot(resolve(dirname(fromFile), spec));
	while (!target.startsWith("src/core/") && isPureCoreShim(join(root, target))) {
		const first = stripComments(readFileSync(join(root, target), "utf8")).split("\n").map((l) => l.trim()).find((l) => l.length > 0)!;
		const spec2 = /from\s*["']([^"']+)["']/.exec(first)![1];
		target = underRoot(resolve(dirname(join(root, target)), spec2));
	}
	return target;
}

describe("the src/core library boundary", () => {
	const files = [...walk(coreDir)];

	it("finds the moved library modules", () => {
		// A guard against glob rot: if src/core/ ever empties, the boundary test must fail
		// loudly rather than pass vacuously. The slice-4b move carries ~35 files.
		expect(files.length).toBeGreaterThanOrEqual(30);
		for (const name of ["types.ts", "config.ts", "manifest.ts", "catalog.ts", "availability.ts", "denylist.ts", "otp-policy.ts", "agents.ts", "router-core.ts", "index.ts"]) {
			expect(files, name).toContain(join(coreDir, name));
		}
	});

	it("imports only node builtins, declared npm dependencies, and src/core-relative paths", () => {
		const violations: string[] = [];
		for (const file of files) {
			const underCore = underRoot(file);
			for (const spec of importedSpecifiers(readFileSync(file, "utf8"))) {
				if (spec.startsWith("node:")) continue; // builtins are always allowed
				if (spec.startsWith(".")) {
					const target = resolveRelative(file, spec);
					if (target.startsWith("src/core/")) continue;
					if (allowedOutside.has(`${underCore} -> ${target}`)) continue;
					violations.push(`${underCore}: relative import "${spec}" resolves outside src/core/ (${target})`);
					continue;
				}
				// Bare specifier: a npm package — allowed when it is a declared runtime
				// dependency (the org's @cldmv/lib-otp among them). Subpaths like
				// "@octokit/core" resolve to their package name first.
				const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
				if (allowedNpm.has(pkgName)) continue;
				violations.push(`${underCore}: import "${spec}" is not a declared runtime dependency (dependencies: ${[...allowedNpm].join(", ")})`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("allows no outside edges at all", () => {
		// The allowlist must never grow silently: if a future exception is added to
		// allowedOutside, this pin forces it to be named here too.
		expect([...allowedOutside]).toEqual([]);
	});
});
