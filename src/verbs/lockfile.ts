/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/verbs/lockfile.ts
 *	@Date: 2026-11-01T00:00:00+00:00 (1793491200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T00:00:00+00:00 (1793491200)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Lockfile reading for report_alert_status: which versions of a package a lockfile
 * resolves, and whether any of them is still inside a Dependabot alert's vulnerable range.
 *
 * Covers the three npm-ecosystem lockfiles — `package-lock.json` / `npm-shrinkwrap.json`
 * (v1 nested `dependencies` and v2/v3 flat `packages`), `pnpm-lock.yaml` (v5 `/name/ver`,
 * v6 `/name@ver`, v9 `name@ver` keys) and `yarn.lock` (classic and Berry). The YAML-ish
 * formats are scanned line by line instead of parsed, which is all the version lookup needs
 * and keeps the broker free of a YAML dependency.
 *
 * Versions are compared with a small semver implementation (numeric core plus prerelease
 * precedence), enough for Dependabot's comparator ranges like `>= 4.0.0, < 4.17.21`.
 */

export type LockfileKind = "npm" | "pnpm" | "yarn";

/** Lockfile names, in the order they are looked for next to a manifest. */
export const LOCKFILE_NAMES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];

export function lockfileKind(path: string): LockfileKind | undefined {
	const base = path.slice(path.lastIndexOf("/") + 1);
	if (base === "package-lock.json" || base === "npm-shrinkwrap.json") return "npm";
	if (base === "pnpm-lock.yaml") return "pnpm";
	if (base === "yarn.lock") return "yarn";
	return undefined;
}

/**
 * Lockfile paths to try for an alert's manifest, nearest first. A manifest that is itself
 * a lockfile is the only candidate. For a `package.json` the lockfile can sit beside it or,
 * in a workspace, at any parent up to the repo root.
 */
export function lockfileCandidates(manifest: string): string[] {
	if (lockfileKind(manifest)) return [manifest];
	const parts = manifest.split("/").slice(0, -1);
	const out: string[] = [];
	for (let depth = parts.length; depth >= 0; depth--) {
		const dir = parts.slice(0, depth).join("/");
		for (const name of LOCKFILE_NAMES) out.push(dir ? `${dir}/${name}` : name);
	}
	return out;
}

interface NpmLockEntry {
	name?: string;
	version?: string;
	link?: boolean;
	dependencies?: Record<string, NpmLockEntry>;
}

function npmVersions(text: string, pkg: string): string[] | undefined {
	let lock: { packages?: Record<string, NpmLockEntry>; dependencies?: Record<string, NpmLockEntry> };
	try {
		lock = JSON.parse(text);
	} catch {
		return undefined;
	}
	const out: string[] = [];
	if (lock.packages && typeof lock.packages === "object") {
		for (const [key, entry] of Object.entries(lock.packages)) {
			if (key === "" || entry.link || typeof entry.version !== "string") continue;
			const name = entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
			if (name === pkg) out.push(entry.version);
		}
		return out;
	}
	const walk = (deps: Record<string, NpmLockEntry> | undefined) => {
		for (const [name, entry] of Object.entries(deps ?? {})) {
			if (name === pkg && typeof entry.version === "string") out.push(entry.version);
			walk(entry.dependencies);
		}
	};
	walk(lock.dependencies);
	return out;
}

function pnpmVersions(text: string, pkg: string): string[] {
	const out: string[] = [];
	let inPackages = false;
	for (const line of text.split(/\r?\n/)) {
		if (/^\S/.test(line)) {
			inPackages = /^packages:\s*$/.test(line);
			continue;
		}
		if (!inPackages) continue;
		const m = /^ {2}(\S.*):\s*$/.exec(line);
		if (!m) continue;
		const key = m[1]!.replace(/^['"]|['"]$/g, "").replace(/^\//, "");
		let rest: string | undefined;
		if (key.startsWith(`${pkg}@`)) rest = key.slice(pkg.length + 1);
		else if (key.startsWith(`${pkg}/`)) rest = key.slice(pkg.length + 1).split("_")[0];
		const version = rest?.split("(")[0];
		if (version && /^\d/.test(version)) out.push(version);
	}
	return out;
}

function yarnVersions(text: string, pkg: string): string[] {
	const out: string[] = [];
	let matching = false;
	for (const line of text.split(/\r?\n/)) {
		if (line === "" || line.startsWith("#")) continue;
		if (/^\S.*:$/.test(line)) {
			const specs = line.slice(0, -1).split(/,\s*/).map((s) => s.trim().replace(/^"|"$/g, ""));
			matching = specs.some((s) => s.slice(0, s.indexOf("@", 1)) === pkg);
			continue;
		}
		if (!matching) continue;
		const v = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
		if (v) {
			out.push(v[1]!);
			matching = false;
		}
	}
	return out;
}

/** Every version of `pkg` the lockfile resolves, de-duplicated; undefined when the file can't be parsed. */
export function installedVersions(kind: LockfileKind, text: string, pkg: string): string[] | undefined {
	const raw = kind === "npm" ? npmVersions(text, pkg) : kind === "pnpm" ? pnpmVersions(text, pkg) : yarnVersions(text, pkg);
	return raw ? [...new Set(raw)] : undefined;
}

interface Semver {
	core: [number, number, number];
	pre: string[];
}

function parseVersion(v: string): Semver | undefined {
	const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
	if (!m) return undefined;
	return { core: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ? m[4].split(".") : [] };
}

function comparePre(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return b.length - a.length; // a release outranks any prerelease of it
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i];
		const y = b[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const xn = /^\d+$/.test(x);
		const yn = /^\d+$/.test(y);
		if (xn && yn) {
			if (Number(x) !== Number(y)) return Number(x) - Number(y);
		} else if (xn !== yn) {
			return xn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

/** Semver precedence: negative, zero or positive. Undefined when either side isn't a version. */
export function compareVersions(a: string, b: string): number | undefined {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) return undefined;
	for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
	return comparePre(x.pre, y.pre);
}

/** Whether `version` falls inside a Dependabot range like `>= 4.0.0, < 4.17.21`. Undefined when either can't be read. */
export function inRange(version: string, range: string): boolean | undefined {
	for (const part of range.split(",")) {
		const m = /^\s*(<=|>=|<|>|=)?\s*(\S+)\s*$/.exec(part);
		if (!m) return undefined;
		const cmp = compareVersions(version, m[2]!);
		if (cmp === undefined) return undefined;
		const op = m[1] ?? "=";
		const ok = op === "<" ? cmp < 0 : op === "<=" ? cmp <= 0 : op === ">" ? cmp > 0 : op === ">=" ? cmp >= 0 : cmp === 0;
		if (!ok) return false;
	}
	return true;
}

/**
 * Whether any of `versions` is still vulnerable. Uses the alert's vulnerable range when it
 * can be read, and falls back to "below the first patched version". Undefined when neither
 * gives an answer for some version. An empty list is not vulnerable (the package is gone).
 */
export function anyVulnerable(versions: string[], range: string | undefined, patched: string | undefined): boolean | undefined {
	let unknown = false;
	for (const v of versions) {
		let vuln = range ? inRange(v, range) : undefined;
		if (vuln === undefined && patched) {
			const cmp = compareVersions(v, patched);
			vuln = cmp === undefined ? undefined : cmp < 0;
		}
		if (vuln === true) return true;
		if (vuln === undefined) unknown = true;
	}
	return unknown ? undefined : false;
}
