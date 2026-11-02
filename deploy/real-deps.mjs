/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /deploy/real-deps.mjs
 *	@Date: 2026-11-01T20:43:03-08:00 (1793594583)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T20:43:03-08:00 (1793594583)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The real effects behind the `gh-broker` CLI (lib/cli.mjs), also used by the installer for the
 * MCP config and smoke test. Wiring only: the logic and its tests are in lib/. Kept apart from
 * cli.mjs because cli.mjs awaits the installer, which imports this.
 */
import { readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGroups, parsePasswd } from "./lib/agents.mjs";
import { readState, writeStateAtomic, writeFileAtomic, storeSeed } from "./lib/otp.mjs";
import { readOwnedFile } from "./lib/mcp-config.mjs";
import { readSecretsFile, writeSecretsFile } from "./lib/secret-store.mjs";
import { smokeTest } from "./lib/smoke.mjs";
import { run, isRoot, requireUid, requireGid, systemdCredsEncrypt, writeCredsDropin, restartService, ensureAgentGroup, removeAgentGroup } from "./lib/system.mjs";

const SVC = "gh-broker";
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const configDir = () => process.env.GH_BROKER_CONFIG_DIR || "/etc/gh-broker";
const configPath = () => process.env.GH_BROKER_CONFIG || join(configDir(), "config.json");
const readText = (p) => {
	try {
		return readFileSync(p, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return undefined;
		throw err;
	}
};

/** The real effects for lib/cli.mjs `runCli` (also used by the installer for the MCP config and smoke test). */
export function realDeps() {
	return {
		log: (m) => console.log(m),
		error: (m) => console.error(m),
		now: () => Date.now(),
		isRoot,
		host: () => hostname(),
		readConfig: () => JSON.parse(readFileSync(configPath(), "utf8")),
		groups: () => parseGroups(readText("/etc/group") ?? ""),
		userInfo: (user) => {
			const r = run("getent", ["passwd", user], { allowFail: true });
			return r.status === 0 ? parsePasswd(r.stdout) : undefined;
		},
		ensureGroup: (user) => ensureAgentGroup(user, SVC),
		removeGroup: removeAgentGroup,
		mcpIO: { read: readOwnedFile, write: (p, text, owner) => writeFileAtomic(p, text, owner) },
		socketExists: existsSync,
		smoke: smokeTest,
		versions: () => ({ pkg: JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version, deployed: readText("/opt/gh-broker/version")?.trim() }),
		readState: (path) => readState(path),
		writeState: (path, state) => writeStateAtomic(path, state, { uid: requireUid(SVC), gid: requireGid(SVC) }),
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
					listCreds: (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".cred")).map((f) => f.slice(0, -".cred".length)) : []),
					writeDropin: writeCredsDropin
				}
			});
		},
		restart: restartService,
		sudoUser: () => process.env.SUDO_USER,
		// Same journal identifier as the daemon (SyslogIdentifier=gh-broker), so `journalctl -t gh-broker` shows both.
		audit: (entry) => run("systemd-cat", ["--identifier=gh-broker", "--priority=notice"], { input: `${JSON.stringify(entry)}\n` })
	};
}
