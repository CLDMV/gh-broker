/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/real-deps.ts
 *	@Date: 2026-11-01T20:43:03-08:00 (1793594583)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-21T12:23:30-08:00 (1795292610)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The real effects behind the `gh-broker` CLI (src/cli/cli.ts), also used by the installer for the
 * MCP config and smoke test. Wiring only: the logic is in the other files of src/cli/. Kept apart from
 * cli.ts so the installer can import it without pulling in the dispatcher.
 */
import { readFileSync, existsSync, readdirSync, rmSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGroups, parsePasswd } from "./agents.ts";
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

/** The real effects for src/cli/cli.ts `runCli` (also used by the installer for the MCP config and smoke test). */
export function realDeps(): CliDeps {
	let store: ReturnType<typeof stateStore> | undefined;
	const states = (): ReturnType<typeof stateStore> => (store ??= stateStore({ uid: requireUid(SVC), gid: requireGid(SVC) }));
	return {
		log: (m) => console.log(m),
		error: (m) => console.error(m),
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
			const r = spawnSync("/usr/local/bin/gh-broker", args, { stdio: "inherit" });
			if (r.error) throw new Error(`/usr/local/bin/gh-broker ${args[0]}: ${r.error.message}`);
			if (r.status !== 0)
				throw Object.assign(new Error(`/usr/local/bin/gh-broker ${args.join(" ")} exited ${r.status ?? `on signal ${r.signal}`}`), {
					status: r.status
				});
		},
		sudoUser: () => process.env.SUDO_USER,
		// Same journal identifier as the daemon (SyslogIdentifier=gh-broker), so `journalctl -t gh-broker` shows both.
		audit: (entry) => run("systemd-cat", ["--identifier=gh-broker", "--priority=notice"], { input: `${JSON.stringify(entry)}\n` })
	};
}
