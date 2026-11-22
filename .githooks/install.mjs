#!/usr/bin/env node
/**
 * @fileoverview Installs the committed pre-commit hook into `.git/hooks/pre-commit`.
 *
 * Wire it into package.json so it runs on `npm install`. Use the guarded form
 * below — NOT a bare `node .githooks/install.mjs`: `prepare` also runs on
 * `npm pack` / `npm publish` against the packed tree, where `.githooks/` is
 * excluded from `files`, so a bare invocation fails module resolution and
 * aborts the publish before the guards below can run.
 *   "scripts": { "prepare": "node -e \"import('./.githooks/install.mjs').catch(()=>{})\"" }
 * Copy this file + `pre-commit` (from CLDMV/.github examples/git-hooks/) into
 * the repo's `.githooks/` directory.
 *
 * Why copy into `.git/hooks` rather than set `core.hooksPath`: a per-repo
 * `core.hooksPath` SHADOWS a global `core.hooksPath` dispatcher, silently
 * disabling any global commit policy (no-coauthor / no-unsigned-push) for that
 * repo. A global dispatcher instead CHAINS to `.git/hooks/<name>`, so installing
 * here composes with global policy instead of replacing it.
 *
 * Guards (each exits 0 — install is best-effort, never fails a build):
 *   - CI:                nothing commits on CI, skip.
 *   - inside node_modules: this package installed as a dependency, skip.
 *   - no `.git` dir:     tarball / shallow export / worktree pointer, skip.
 */
import { existsSync, mkdirSync, copyFileSync, chmodSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

if (process.env.CI) process.exit(0);
if (repoRoot.split(sep).includes("node_modules")) process.exit(0);

const gitDir = join(repoRoot, ".git");
if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) process.exit(0);

const hooksDir = join(gitDir, "hooks");
mkdirSync(hooksDir, { recursive: true });

const dest = join(hooksDir, "pre-commit");
copyFileSync(join(here, "pre-commit"), dest);
try {
	chmodSync(dest, 0o755);
} catch {
	/* Windows has no executable bit — ignore. */
}
console.log("✓ installed .git/hooks/pre-commit (CLDMV lint/format gate)");
