/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/system.ts
 *	@Date: 2026-09-06T10:05:35-07:00 (1788714335)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-22T23:00:19-08:00 (1795417219)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	chmodSync,
	chownSync,
	lstatSync,
	writeFileSync,
	cpSync,
	rmSync,
	renameSync,
	realpathSync,
	copyFileSync
} from "node:fs";
import { join, dirname } from "node:path";
import { NODE_PATH } from "./agents.ts";

/** The directory the broker's node link (NODE_PATH) lives in: root:root 0755, never service-user-owned. */
const NODE_LINK_DIR = dirname(NODE_PATH);

/** spawnSync wrapper: throws on non-zero unless opts.allowFail. Returns the result. */
/** Options for {@link run}: any spawnSync option, plus `allowFail`. */
export type RunOptions = Partial<SpawnSyncOptionsWithStringEncoding> & { allowFail?: boolean };

export function run(cmd: string, args: string[] = [], opts: RunOptions = {}): SpawnSyncReturns<string> {
	const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
	if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
	if (r.status !== 0 && !opts.allowFail) {
		throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}: ${(r.stderr || r.stdout || "").trim()}`);
	}
	return r;
}

export function has(cmd: string): boolean {
	return spawnSync("sh", ["-c", `command -v ${cmd} >/dev/null 2>&1`]).status === 0;
}
export function isRoot(): boolean {
	return typeof process.getuid === "function" && process.getuid() === 0;
}

export function userExists(name: string): boolean {
	return run("id", [name], { allowFail: true, stdio: "ignore" }).status === 0;
}
export function groupExists(name: string): boolean {
	return run("getent", ["group", name], { allowFail: true }).status === 0;
}
export function gidOf(name: string): number | undefined {
	const r = run("getent", ["group", name], { allowFail: true });
	if (r.status !== 0) return undefined;
	const gid = Number(r.stdout.split(":")[2]);
	return Number.isFinite(gid) ? gid : undefined;
}
export function uidOf(name: string): number | undefined {
	const r = run("id", ["-u", name], { allowFail: true });
	if (r.status !== 0) return undefined;
	const uid = Number(r.stdout.trim());
	return Number.isFinite(uid) ? uid : undefined;
}

/**
 * gidOf/uidOf that throw a clear error when the name can't be resolved. Used
 * wherever ownership is set, so a broken getent/id lookup fails fast instead of
 * silently leaving a path with the wrong owner/group (or running chown NaN:NaN).
 */
export function requireGid(name: string): number {
	const gid = gidOf(name);
	if (gid === undefined) throw new Error(`gh-broker install: cannot resolve gid for group "${name}"`);
	return gid;
}
export function requireUid(name: string): number {
	const uid = uidOf(name);
	if (uid === undefined) throw new Error(`gh-broker install: cannot resolve uid for user "${name}"`);
	return uid;
}

export function ensureGroup(name: string): void {
	if (!groupExists(name)) run("groupadd", ["--system", name]);
}
/** Create the dedicated service user + its group (idempotent). Agents get their own groups (ensureAgentGroup). */
export function ensureServiceUser(svcUser: string, svcGroup: string): void {
	ensureGroup(svcGroup);
	if (!userExists(svcUser)) {
		run("useradd", [
			"--system",
			"--gid",
			svcGroup,
			"--home-dir",
			"/nonexistent",
			"--shell",
			"/usr/sbin/nologin",
			"--comment",
			"CLDMV gh-broker service",
			svcUser
		]);
	}
}

/** Register an agent: its `gh-broker-agent-<user>` group with exactly the service user and the agent as members (idempotent). */
export function ensureAgentGroup(user: string, svcUser = "gh-broker"): void {
	const group = `gh-broker-agent-${user}`;
	ensureGroup(group);
	// Set the member list outright, so an extra member left in the group is removed.
	run("gpasswd", ["--members", `${svcUser},${user}`, group]);
}

/**
 * Unregister an agent: empty its group, which the broker then ignores. The group itself is kept,
 * because processes the agent already has running keep its gid; deleting the group would free
 * that gid for the next agent's group, and those processes could reach the new agent's socket.
 */
export function removeAgentGroup(user: string): void {
	const group = `gh-broker-agent-${user}`;
	if (groupExists(group)) run("gpasswd", ["--members", "", group]);
}

/** Create a plain unprivileged agent user with a home + login shell, and no sudo. */
export function createAgentUser(name: string): void {
	run("useradd", ["--create-home", "--shell", "/bin/bash", name]);
}

/**
 * Migrate a token from the legacy systemd-creds store: decrypt the host-bound
 * `<name>.cred` (as root, same host) into plaintext for the new secrets file.
 * Returns the token, or null if there's nothing to migrate (file absent, no
 * systemd-creds, wrong host/name → can't decrypt). Never logs the value.
 */
export function trySystemdCredDecrypt(name: string, credFile: string): string | null {
	if (!existsSync(credFile) || !has("systemd-creds")) return null;
	try {
		const r = run("systemd-creds", ["decrypt", `--name=${name}`, credFile, "-"], { allowFail: true });
		if (r.status !== 0) return null;
		const val = r.stdout.replace(/\r?\n$/, "");
		return val || null;
	} catch {
		return null;
	}
}

/** Encrypt a token into a host-bound `.cred` (systemd-creds), 0400 root:root. */
export function systemdCredsEncrypt(name: string, plaintext: string, credFile: string): void {
	run("systemd-creds", ["encrypt", `--name=${name}`, "-", credFile], { input: plaintext });
	chmodSync(credFile, 0o400);
	chownSync(credFile, 0, 0);
}

/** Ensure the creds dir exists (0750 root:group) for the systemd-creds provider. */
export function ensureCredsDir(configDir: string, svcGroup: string): void {
	mkdirp(join(configDir, "creds"), 0o750, 0, requireGid(svcGroup));
}

/** Write a unit drop-in with LoadCredentialEncrypted lines for the given creds, and reload. */
export function writeCredsDropin(names: string[], credsDir: string, unitName = "gh-broker.service"): void {
	const dir = `/etc/systemd/system/${unitName}.d`;
	mkdirp(dir, 0o755, 0, 0);
	const lines = ["[Service]", ...names.map((n) => `LoadCredentialEncrypted=${n}:${join(credsDir, `${n}.cred`)}`), ""];
	writeFileSync(join(dir, "creds.conf"), lines.join("\n"), { mode: 0o644 });
	run("systemctl", ["daemon-reload"]);
}

/** Remove the creds drop-in (used when switching to the file provider), and reload. */
export function removeCredsDropin(unitName = "gh-broker.service"): void {
	const f = `/etc/systemd/system/${unitName}.d/creds.conf`;
	if (existsSync(f)) {
		rmSync(f, { force: true });
		run("systemctl", ["daemon-reload"]);
	}
}

/** The effects for {@link ensureBrokerNodeLink}: where to look for nodes and how to run, hash and download one. Every network/process effect is injected so tests never touch either. */
export interface NodeSourceDeps {
	/** The minimum node version the package needs, parsed from engines.node by the caller. */
	floor: string;
	/** PATH directories, in order — ALL of them, not just the first hit. */
	pathDirs: () => string[];
	/** nvm roots to look under for `versions/node` version directories (`vX/bin/node`; $NVM_DIR, /usr/local/nvm, root's ~/.nvm — never other users' homes). */
	nvmDirs: () => string[];
	/** List a directory's entries (the nvm `v*` version directories); [] when it can't be read. */
	listVersions: (dir: string) => string[];
	/** Run a node binary's `--version` (short timeout); rejects when the binary fails to run. */
	version: (bin: string) => Promise<string>;
	/** sha256 of a file. */
	sha256: (path: string) => Promise<string>;
	/** Download the latest LTS node into `dest` (verified against the release's SHASUMS256.txt) and report the version and source. */
	download: (dest: string) => Promise<{ version: string; source: string }>;
	log: (m: string) => void;
}

/** One semver literal out of an engines range (">=22.0.0", "^22.0.0" → "22.0.0"; the first literal is the minimum). */
export function nodeFloorMin(range: string): string {
	const m = /\d+\.\d+\.\d+/.exec(range);
	if (!m) throw new Error(`cannot parse a node version out of "${range}"`);
	return m[0]!;
}

/** `v22.12.0` (or with surrounding whitespace) → `22.12.0`, as `--version` prints it. */
const normalizeVersion = (v: string): string => v.trim().replace(/^v/, "");

const versionParts = (v: string): [number, number, number] => {
	const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
	if (!m) throw new Error(`not a node version: "${v}"`);
	return [Number(m[1]!), Number(m[2]!), Number(m[3]!)];
};
const compareVersions = (a: string, b: string): number => {
	const [a1, a2, a3] = versionParts(a);
	const [b1, b2, b3] = versionParts(b);
	return a1 - b1 || a2 - b2 || a3 - b3;
};
/** Only even (LTS) majors count; an odd major is ignored even when it is the highest. */
const isEvenMajor = (v: string): boolean => versionParts(v)[0]! % 2 === 0;

/**
 * The broker's own node (NODE_PATH, the one binary every agent's bridge runs): ensure its
 * directory is root:root 0755 — creating it when missing, refusing one root didn't create (its
 * contents may be someone else's, and the service user must never be able to swap the binary the
 * bridges run) — then put a root-owned COPY of a qualifying node there, replacing it atomically
 * (write to a temp file, run its --version, rename over the final name) so a running bridge keeps
 * the old inode while the new one lands. A copy, not a symlink: a link into nvm is only as safe
 * as whoever owns the target and dangles when that version is removed. Candidates, in order: every
 * `node` on PATH (all PATH entries), the system nvm roots, the node running the installer;
 * download is the fallback. Only even (LTS) majors at or above the floor count, and a candidate's
 * version is read by RUNNING it, never from its path. An existing working copy is replaced only by
 * a strictly newer version (same version only when its sha256 differs) — never a downgrade — and
 * the copy is skipped entirely when the version and sha256 both match. Nothing under
 * /usr/local/bin is touched: binaries there are left for whatever may rely on them.
 */
export async function ensureBrokerNodeLink(nodeBin: string, deps: NodeSourceDeps): Promise<void> {
	let dir: { uid: number; gid: number; mode: number; isDirectory: () => boolean } | undefined;
	try {
		dir = lstatSync(NODE_LINK_DIR);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (dir === undefined) {
		mkdirSync(NODE_LINK_DIR, { recursive: true, mode: 0o755 });
		chmodSync(NODE_LINK_DIR, 0o755); // mkdirSync's mode is umask-masked; this one is not
		chownSync(NODE_LINK_DIR, 0, 0);
	} else {
		const mode = dir.mode & 0o777;
		if (!dir.isDirectory())
			throw new Error(
				`${NODE_LINK_DIR} exists but is not a directory (mode ${mode.toString(8)}); it must be a root:root 0755 directory: sudo rm -rf ${NODE_LINK_DIR} && sudo mkdir -p ${NODE_LINK_DIR} && sudo chown root:root ${NODE_LINK_DIR} && sudo chmod 755 ${NODE_LINK_DIR}`
			);
		if (dir.uid !== 0 || dir.gid !== 0 || (mode & 0o022) !== 0)
			throw new Error(
				`${NODE_LINK_DIR} is owned by uid ${dir.uid}/gid ${dir.gid} with mode ${mode.toString(8)}; the broker's node must live in a root:root 0755 directory (its contents may be someone else's). Fix it by hand: sudo chown root:root ${NODE_LINK_DIR} && sudo chmod 755 ${NODE_LINK_DIR}`
			);
	}

	/** Put a working node binary at NODE_PATH: write/copy to a temp file, prove it runs, rename it over. */
	const install = async (from: (dest: string) => Promise<void>, why: string): Promise<void> => {
		const temp = `${NODE_LINK_DIR}/node.tmp-${process.pid}`;
		try {
			await from(temp);
			chmodSync(temp, 0o755); // root:root 0755, like the directory
			const v = normalizeVersion(await deps.version(temp)); // the copy must actually run
			renameSync(temp, NODE_PATH); // running bridges keep the old inode until this instant
			deps.log(`broker node: v${v} ${why}`);
		} catch (err) {
			rmSync(temp, { force: true });
			throw err;
		}
	};

	// What runs today: missing or broken means a first install; a working at-or-above-floor copy
	// means a later run that only ever moves forward.
	let existing: string | undefined;
	try {
		existing = normalizeVersion(await deps.version(NODE_PATH));
	} catch {
		existing = undefined;
	}

	// Candidates, in order: every node on PATH (all entries), the system nvm roots, the node
	// running this installer. Deduped; each one's version is read by running it.
	const candidates: string[] = [];
	const push = (bin: string): void => {
		if (!candidates.includes(bin) && existsSync(bin)) candidates.push(bin);
	};
	for (const d of deps.pathDirs()) push(`${d}/node`);
	for (const n of deps.nvmDirs()) for (const v of deps.listVersions(`${n}/versions/node`)) push(`${n}/versions/node/${v}/bin/node`);
	push(realpathSync(nodeBin));
	const qualifying: Array<{ bin: string; version: string }> = [];
	for (const bin of candidates) {
		let v: string;
		try {
			v = normalizeVersion(await deps.version(bin));
		} catch {
			continue; // fails to run: not a candidate
		}
		if (!isEvenMajor(v) || compareVersions(v, deps.floor) < 0) continue; // odd major or below the floor
		qualifying.push({ bin, version: v });
	}
	qualifying.sort((a, b) => compareVersions(b.version, a.version)); // highest first (stable: PATH before nvm on ties)
	const best = qualifying[0];

	if (existing !== undefined && compareVersions(existing, deps.floor) >= 0) {
		// Later run: replace only on strictly newer — or the same version when the build differs —
		// and never downgrade.
		if (!best || compareVersions(best.version, existing) < 0) {
			deps.log(`broker node: kept v${existing} (nothing newer on this box)`);
			return;
		}
		if (compareVersions(best.version, existing) === 0 && (await deps.sha256(best.bin)) === (await deps.sha256(NODE_PATH))) {
			deps.log(`broker node: kept v${existing} (same version and sha256 as ${best.bin})`);
			return;
		}
		await install(async (dest) => copyFileSync(best.bin, dest), `from ${best.bin}`);
		return;
	}
	// First install (no copy, or a broken or below-floor one): the highest qualifying node, else download.
	if (!best) {
		deps.log("broker node: no qualifying node on this box; downloading the latest LTS");
		await install(async (dest) => void (await deps.download(dest)), "downloaded (nodejs.org dist, latest LTS)");
		return;
	}
	await install(async (dest) => copyFileSync(best.bin, dest), `from ${best.bin}`);
}

/** The real path of the node running this installer — the node the service will use. */
export function currentNodeBin(): string {
	return realpathSync(process.execPath);
}

function mkdirp(path: string, mode: number, uid: number | undefined, gid: number | undefined): void {
	if (!existsSync(path)) mkdirSync(path, { recursive: true, mode });
	chmodSync(path, mode);
	// Every caller passes a resolved uid and gid (requireUid/requireGid throw otherwise), so the skipped-chown branch is unreachable.
	/* v8 ignore else */
	if (uid !== undefined && gid !== undefined) chownSync(path, uid, gid);
}

/**
 * Create the GHCR drop directory: `2750 <agentUser>:<svcGroup>`. The agent (owner) writes
 * archives there; the setgid bit gives every new file the service group, so the broker can
 * read a group-readable archive while other users can't see in. A missing parent is created
 * `0755 root:root`; an existing parent is never chmod-ed. Refuses a symlink at the path. An
 * existing directory keeps its owner: `agentUser` only owns a directory created now.
 */
export function ensureDropDir(path: string, agentUser: string, svcGroup: string): { created: boolean } {
	const parent = dirname(path);
	if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o755 });
	let st: ReturnType<typeof lstatSync> | undefined;
	try {
		st = lstatSync(path); // lstat: a symlink (even a dangling one) is seen as itself
	} catch {
		st = undefined;
	}
	if (!st) mkdirSync(path, { mode: 0o750 });
	else if (st.isSymbolicLink()) throw new Error(`gh-broker install: ${path} is a symlink — refusing to use it as the GHCR drop dir`);
	else if (!st.isDirectory()) throw new Error(`gh-broker install: ${path} exists and is not a directory`);
	chownSync(path, st ? st.uid : requireUid(agentUser), requireGid(svcGroup));
	chmodSync(path, 0o2750); // after chown: chown clears the setgid bit
	return { created: !st };
}

/** Create /etc/gh-broker (0750 root:group) and /opt/gh-broker (0755 svcUser:group). */
export function ensureDirs(configDir: string, appDir: string, svcUser: string, svcGroup: string): void {
	const gid = requireGid(svcGroup);
	const uid = requireUid(svcUser);
	mkdirp(configDir, 0o750, 0, gid);
	mkdirp(appDir, 0o755, uid, gid);
}

/** Install the systemd unit and reload. */
export function installUnit(srcPath: string, unitPath = "/etc/systemd/system/gh-broker.service"): void {
	cpSync(srcPath, unitPath);
	chmodSync(unitPath, 0o644);
	run("systemctl", ["daemon-reload"]);
}
export function enableService(): void {
	run("systemctl", ["enable", "gh-broker.service"], { allowFail: true });
}
export function restartService(): void {
	run("systemctl", ["restart", "gh-broker.service"]);
}
export function serviceActive(): string {
	return run("systemctl", ["is-active", "gh-broker.service"], { allowFail: true }).stdout.trim();
}

/** Sync the built dist/ into the app dir and chown it to the service user. */
export function deployDist(srcDir: string, destDir: string, svcUser: string, svcGroup: string): void {
	const gid = requireGid(svcGroup);
	const uid = requireUid(svcUser);
	mkdirp(destDir, 0o755, uid, gid);
	const dist = join(destDir, "dist");
	if (has("rsync")) {
		run("rsync", ["-a", "--delete", "--exclude", "core/", `${srcDir}/`, `${dist}/`]);
	} else {
		rmSync(dist, { recursive: true, force: true });
		cpSync(srcDir, dist, { recursive: true });
		// The library bundle's imports are external (resolved from the consumer's
		// node_modules), so it cannot run from the no-node_modules /opt tree — the
		// deployed daemon is dist/index.mjs only; the library ships from npm.
		rmSync(join(dist, "core"), { recursive: true, force: true });
	}
	run("chown", ["-R", `${uid}:${gid}`, destDir]);
}

/** Write the token-free config, 0640 root:group. */
export function writeConfigFile(path: string, obj: unknown, svcGroup: string): void {
	const gid = requireGid(svcGroup);
	writeFileSync(path, JSON.stringify(obj, null, "\t") + "\n", { mode: 0o640 });
	chmodSync(path, 0o640);
	chownSync(path, 0, gid);
}
