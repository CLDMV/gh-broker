/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/real-deps.ts
 *	@Date: 2026-11-01T20:43:03-08:00 (1793594583)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-22T23:00:19-08:00 (1795417219)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The real effects behind the `gh-broker` CLI (src/cli/cli.ts), also used by the installer for the
 * MCP config and smoke test. Wiring only: the logic is in the other files of src/cli/. Kept apart from
 * cli.ts so the installer can import it without pulling in the dispatcher.
 */
import { readFileSync, existsSync, readdirSync, rmSync, renameSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname, homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect as netConnect } from "node:net";
import { createHash } from "node:crypto";
import { CLI_PATH, parseGroups, parsePasswd } from "./agents.ts";
import type { ConnectDeps } from "./connect.ts";
import { nodeFloorMin, type NodeSourceDeps } from "./system.ts";
import { SEMVER } from "./upgrade.ts";
import { stateStore, writeFileAtomic, storeSeed } from "./otp.ts";
import { pinner, readOwnedFile, scanConfigFolders, sessionConfigFolders } from "./mcp-config.ts";
import { tmuxPaneText, tmuxPanes, tmuxSend, tmuxSockets } from "./tmux.ts";
import { WAIT_UNIT } from "./reconnect.ts";
import { readSecretsFile, writeSecretsFile } from "./secret-store.ts";
import { smokeTest } from "./smoke.ts";
import type { CliDeps } from "./cli.ts";
import type { ConfigLayer } from "./config-merge.ts";
import type { FileOwner } from "./mcp-config.ts";
import {
	run,
	isRoot,
	requireUid,
	requireGid,
	systemdCredsEncrypt,
	writeCredsDropin,
	restartService,
	ensureAgentGroup,
	removeAgentGroup
} from "./system.ts";

const SVC = "gh-broker";
// The package root: this module is bundled into bin/gh-broker.mjs.
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const configDir = (): string => process.env.GH_BROKER_CONFIG_DIR || "/etc/gh-broker";
const configPath = (): string => process.env.GH_BROKER_CONFIG || join(configDir(), "config.json");
const readText = (p: string): string | undefined => {
	try {
		return readFileSync(p, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
};

/** The version `install` recorded in /opt/gh-broker (root's own plain file; anything else there is ignored, never followed). */
const deployedVersion = (): string | undefined => {
	try {
		return readOwnedFile("/opt/gh-broker/version", 0)?.text.trim();
	} catch {
		return undefined;
	}
};

/** The real effects for the `connect` stdio bridge (src/cli/connect.ts): the process's own stdio, a real dial and a real timer. */
export function realConnectDeps(): ConnectDeps {
	return {
		stdin: process.stdin,
		stdout: process.stdout,
		log: (m) => console.error(m),
		connect: (path) =>
			new Promise((resolve, reject) => {
				const sock = netConnect(path);
				sock.once("connect", () => resolve(sock));
				sock.once("error", reject);
			}),
		// Unref'd: the bridge holds the event loop open itself (its keep-alive interval), so a
		// pending backoff or hold sleep must not keep the process alive after stdin closes.
		sleep: (ms) =>
			new Promise((resolve) => {
				const t = setTimeout(resolve, ms);
				t.unref();
			})
	};
}

/** The package's minimum node, parsed from its own engines.node range. */
const nodeFloor = (): string => nodeFloorMin(String(JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).engines?.node ?? ""));

/** Fetch a URL's body as text; a network failure or a non-200 is a clear error. */
async function fetchText(url: string): Promise<string> {
	let res: Response;
	try {
		res = await fetch(url);
	} catch (err) {
		throw new Error(`node download: cannot reach ${url}: ${(err as Error).message}`, { cause: err });
	}
	if (!res.ok) throw new Error(`node download: ${url} answered ${res.status}`);
	return res.text();
}

/** Fetch a URL's body as bytes, with the same error handling. */
async function fetchBuffer(url: string): Promise<Buffer> {
	let res: Response;
	try {
		res = await fetch(url);
	} catch (err) {
		throw new Error(`node download: cannot reach ${url}: ${(err as Error).message}`, { cause: err });
	}
	if (!res.ok) throw new Error(`node download: ${url} answered ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

/**
 * Download the latest LTS node from nodejs.org/dist, verify the tarball against that release's
 * SHASUMS256.txt, and extract only `bin/node` to `dest`. A checksum mismatch is a hard failure —
 * an unverified binary is never installed.
 */
async function downloadLatestLts(dest: string): Promise<{ version: string; source: string }> {
	const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : undefined;
	if (!arch) throw new Error(`node download: nodejs.org has no build for ${process.arch}`);
	const index = JSON.parse(await fetchText("https://nodejs.org/dist/index.json")) as Array<{ version: string; lts: boolean | string }>;
	const entry = index.find((e) => e.lts);
	if (!entry) throw new Error("node download: no LTS release in nodejs.org/dist/index.json");
	const base = `https://nodejs.org/dist/${entry.version}`;
	const name = `node-${entry.version}-linux-${arch}.tar.xz`;
	const tarball = `${base}/${name}`;
	const sums = await fetchText(`${base}/SHASUMS256.txt`);
	const expected = sums
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.endsWith(` ${name}`))
		?.split(/\s+/)[0];
	if (!expected) throw new Error(`node download: ${name} is missing from ${base}/SHASUMS256.txt`);
	const actual = createHash("sha256")
		.update(await fetchBuffer(tarball))
		.digest("hex");
	if (actual !== expected)
		throw new Error(
			`node download: checksum mismatch for ${tarball}: expected ${expected}, got ${actual} — not installing an unverified binary`
		);
	const extract = join(tmpdir(), `gh-broker-node-${process.pid}`);
	try {
		mkdirSync(extract, { recursive: true });
		const tarPath = `${dest}.tar.xz`;
		writeFileSync(tarPath, await fetchBuffer(tarball));
		run("tar", ["-xJf", tarPath, "-C", extract, `${name}/bin/node`]);
		copyFileSync(join(extract, name, "bin", "node"), dest);
		rmSync(tarPath, { force: true });
	} finally {
		rmSync(extract, { recursive: true, force: true });
	}
	return { version: entry.version.replace(/^v/, ""), source: tarball };
}

/** The real effects for ensureBrokerNodeLink: discover and vet the nodes on this box, hash and download. */
export function nodeSourceDeps(log: (m: string) => void): NodeSourceDeps {
	return {
		floor: nodeFloor(),
		pathDirs: () => (process.env.PATH ?? "").split(":").filter(Boolean),
		nvmDirs: () => [process.env.NVM_DIR, "/usr/local/nvm", join(homedir(), ".nvm")].filter((d): d is string => Boolean(d)),
		listVersions: (dir) => {
			try {
				return readdirSync(dir).filter((n) => /^v\d/.test(n));
			} catch {
				return []; // no such nvm root
			}
		},
		// A candidate's version is read by running it (never from its path), at most 5s each.
		version: (bin) => {
			const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
			if (r.error) return Promise.reject(new Error(`${bin} --version: ${r.error.message}`));
			if (r.status !== 0) return Promise.reject(new Error(`${bin} --version exited ${r.status ?? `on signal ${r.signal}`}`));
			return Promise.resolve(r.stdout);
		},
		sha256: (path) => Promise.resolve(createHash("sha256").update(readFileSync(path)).digest("hex")),
		download: (dest) => downloadLatestLts(dest),
		log
	};
}

/** The real effects for src/cli/cli.ts `runCli` (also used by the installer for the MCP config and smoke test). */
export function realDeps(): CliDeps {
	let store: ReturnType<typeof stateStore> | undefined;
	const states = (): ReturnType<typeof stateStore> => (store ??= stateStore({ uid: requireUid(SVC), gid: requireGid(SVC) }));
	return {
		log: (m) => console.log(m),
		error: (m) => console.error(m),
		connectDeps: realConnectDeps(),
		now: () => Date.now(),
		isRoot,
		host: () => hostname(),
		readConfig: (): ConfigLayer => JSON.parse(readFileSync(configPath(), "utf8")),
		// Atomic: agent commands now write the live config, and a torn file would stop the daemon.
		writeConfig: (cfg) =>
			writeFileAtomic(configPath(), JSON.stringify(cfg, null, "\t") + "\n", { uid: 0, gid: requireGid(SVC), mode: 0o640 }),
		groups: () => parseGroups(readText("/etc/group") ?? ""),
		userInfo: (user) => {
			const r = run("getent", ["passwd", user], { allowFail: true });
			return r.status === 0 ? parsePasswd(r.stdout) : undefined;
		},
		ensureGroup: (user) => ensureAgentGroup(user, SVC),
		removeGroup: removeAgentGroup,
		mcpIO: (() => {
			const io = {
				read: readOwnedFile,
				write: (p: string, text: string, owner: FileOwner & { mode: number }) => writeFileAtomic(p, text, owner)
			};
			return { ...io, scan: (home) => scanConfigFolders(home), sessions: (uid) => sessionConfigFolders(uid), pin: pinner(io) };
		})(),
		socketExists: existsSync,
		binaryExists: existsSync,
		smoke: smokeTest,
		versions: () => ({ pkg: JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version, deployed: deployedVersion() }),
		readState: (path) => states().read(path),
		writeState: (path, state) => states().write(path, state),
		storeSeed: (cfg, name, seed) => {
			const secrets = cfg.secrets?.path || process.env.GH_BROKER_SECRETS || join(configDir(), "secrets.json");
			const gid = requireGid(SVC);
			return storeSeed({
				config: cfg,
				name,
				seed,
				paths: { secrets, credsDir: join(dirname(configPath()), "creds") },
				io: {
					readSecretsFile,
					writeSecretsFile: (p, v) => writeSecretsFile(p, v, { gid }),
					removeFile: (f) => rmSync(f, { force: true }),
					encrypt: systemdCredsEncrypt,
					rename: renameSync,
					listCreds: (dir) =>
						existsSync(dir)
							? readdirSync(dir)
									.filter((f) => f.endsWith(".cred"))
									.map((f) => f.slice(0, -".cred".length))
							: [],
					writeDropin: writeCredsDropin
				}
			});
		},
		restart: restartService,
		// Every tmux command runs AS THE AGENT (uid/gid, its HOME, no $TMUX) — see src/cli/tmux.ts.
		tmuxSockets: (info) => tmuxSockets(info),
		tmuxPanes: (socket, info) => tmuxPanes(socket, info),
		tmuxPaneText: (socket, pane, info) => tmuxPaneText(socket, pane, info),
		tmuxSend: (socket, pane, text, info) => tmuxSend(socket, pane, text, info),
		// A synchronous pause: the CLI is synchronous, and --wait only polls a few panes.
		sleep: (ms) => {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
		},
		startBackground: (args) => {
			// One background wait at a time: a new --wait re-checked every pane itself, so the
			// old run's panes are covered by the new one. --collect drops the unit when it ends,
			// failed or not; its output stays in the journal under the unit's name.
			run("systemctl", ["stop", `${WAIT_UNIT}.service`], { allowFail: true });
			run("systemctl", ["reset-failed", `${WAIT_UNIT}.service`], { allowFail: true });
			run("systemd-run", [
				`--unit=${WAIT_UNIT}`,
				"--collect",
				"--quiet",
				`--description=gh-broker agent reconnect --wait`,
				process.execPath,
				process.argv[1]!,
				"agent",
				"reconnect",
				...args
			]);
		},
		installedVersion: () => {
			try {
				const v = JSON.parse(readFileSync("/usr/local/lib/node_modules/@cldmv/gh-broker/package.json", "utf8")).version;
				return typeof v === "string" ? v : undefined;
			} catch {
				return undefined; // no global install
			}
		},
		deployedVersion: deployedVersion,
		latestVersion: () => {
			// cwd "/" so a .npmrc planted in the working directory can't add npm config, and the
			// registry pinned like the install below.
			const r = run("npm", ["view", "@cldmv/gh-broker", "version", "--registry", "https://registry.npmjs.org"], {
				allowFail: true,
				cwd: "/"
			});
			const v = r.stdout.trim();
			// the same bar --version is held to: anything that isn't semver isn't a version npm
			// should be handed
			return SEMVER.test(v) ? v : undefined;
		},
		npmInstall: (spec) => {
			// Streamed (a long install must not look hung), from cwd "/" for the same reason as
			// above, with the registry pinned so nothing a planted config adds gets installed.
			const r = spawnSync(
				"npm",
				[
					"install",
					"-g",
					"--prefix",
					"/usr/local",
					"--ignore-scripts",
					"--registry",
					"https://registry.npmjs.org",
					`@cldmv/gh-broker@${spec}`
				],
				{ stdio: "inherit", cwd: "/" }
			);
			if (r.error) throw new Error(`npm install: ${r.error.message}`);
			if (r.status !== 0) throw new Error(`npm install exited ${r.status ?? `on signal ${r.signal}`}`);
		},
		runNewBinary: (args) => {
			// The NEW binary does the installing and the reconnecting: a child process, never this
			// running CLI (which is still the old code until the process exits). stdio is
			// inherited so its prompts work and its progress streams.
			const r = spawnSync(process.execPath, [CLI_PATH, ...args], { stdio: "inherit" });
			if (r.error) throw new Error(`${CLI_PATH} ${args[0]}: ${r.error.message}`);
			if (r.status !== 0)
				throw Object.assign(new Error(`${CLI_PATH} ${args.join(" ")} exited ${r.status ?? `on signal ${r.signal}`}`), {
					status: r.status
				});
		},
		sudoUser: () => process.env.SUDO_USER,
		// Same journal identifier as the daemon (SyslogIdentifier=gh-broker), so `journalctl -t gh-broker` shows both.
		audit: (entry) => run("systemd-cat", ["--identifier=gh-broker", "--priority=notice"], { input: `${JSON.stringify(entry)}\n` })
	};
}
