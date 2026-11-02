#!/usr/bin/env node
/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /deploy/cli.mjs
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
 * The `gh-broker` command on root's PATH: `sudo gh-broker otp unlock | status | rotate`.
 * Bundled to dist/cli.mjs (so it carries its own dependencies) and deployed to
 * /opt/gh-broker/dist/ by the installer, which also writes the /usr/local/bin/gh-broker
 * launcher. This file is only the real wiring; the logic is in lib/otp-cli.mjs and lib/otp.mjs.
 */
import { readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "./lib/otp-cli.mjs";
import { readState, writeStateAtomic, storeSeed } from "./lib/otp.mjs";
import { readSecretsFile, writeSecretsFile } from "./lib/secret-store.mjs";
import { isRoot, requireUid, requireGid, systemdCredsEncrypt, writeCredsDropin, restartService } from "./lib/system.mjs";

const SVC = "gh-broker";
const configDir = () => process.env.GH_BROKER_CONFIG_DIR || "/etc/gh-broker";
const configPath = () => process.env.GH_BROKER_CONFIG || join(configDir(), "config.json");

/** The real effects for lib/otp-cli.mjs `runCli`. */
export function realDeps() {
	return {
		log: (m) => console.log(m),
		error: (m) => console.error(m),
		now: () => Date.now(),
		isRoot,
		host: () => hostname(),
		readConfig: () => JSON.parse(readFileSync(configPath(), "utf8")),
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
		restart: restartService
	};
}

/** Run the CLI with the real effects and set the exit code. */
export async function main(argv = process.argv.slice(2)) {
	process.exitCode = await runCli(argv, realDeps());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
