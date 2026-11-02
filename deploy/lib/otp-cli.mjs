/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /deploy/lib/otp-cli.mjs
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
 * `gh-broker otp unlock | status | rotate`: the root-side half of the OTP gate (#143). The
 * dispatch and the commands live here with every effect injected (see deploy/cli.mjs for the
 * real wiring), so they are testable without root. `unlock` and `status` work on the state file
 * the daemon writes; `rotate` makes a new seed, stores it, shows it and restarts the service.
 */
import { DEFAULT_STATE_PATH, DEFAULT_MAX_FAILURES, DEFAULT_MAX_LOCKOUTS, describeState, formatStatus, generateSeed, readState, seedCredName, showSeed, unlockedState } from "./otp.mjs";

export const USAGE = `Usage: sudo gh-broker otp <command>

Commands:
  unlock           clear a short lockout or the hard lock (the bad-code counters and lock history)
  status [--json]  show the lock state from the state file
  rotate           make a new OTP seed, store it, show it once, restart the service

Install or upgrade the broker itself with: sudo npx @cldmv/gh-broker`;

/**
 * @param {string[]} argv  arguments after the program name, e.g. ["otp", "unlock"]
 * @param {object} d       injected effects: log, error, now, isRoot, host, readConfig, readState,
 *                         writeState, newSeed, storeSeed, restart, qr
 * @returns {Promise<number>} the process exit code
 */
export async function runCli(argv, d) {
	const [group, command, ...rest] = argv;
	if (group === undefined || group === "-h" || group === "--help" || group === "help") {
		d.log(USAGE);
		return 0;
	}
	if (group !== "otp" || !["unlock", "status", "rotate"].includes(command)) {
		d.error(`gh-broker: unknown command "${argv.join(" ")}"\n${USAGE}`);
		return 2;
	}
	if (!d.isRoot()) {
		d.error(`gh-broker otp ${command}: must run as root: sudo gh-broker otp ${command}`);
		return 1;
	}
	let config;
	try {
		config = d.readConfig();
	} catch (err) {
		d.error(`gh-broker otp ${command}: cannot read the broker config: ${err.message}`);
		return 1;
	}
	try {
		if (command === "status") return status(config, rest, d);
		if (command === "unlock") return unlock(config, d);
		return await rotate(config, d);
	} catch (err) {
		d.error(`gh-broker otp ${command}: ${err.message}`);
		return 1;
	}
}

const statePathOf = (config) => config.otp?.statePath ?? DEFAULT_STATE_PATH;
const limitsOf = (config) => ({ maxFailures: config.otp?.maxFailures ?? DEFAULT_MAX_FAILURES, maxLockouts: config.otp?.maxLockouts ?? DEFAULT_MAX_LOCKOUTS });

function status(config, rest, d) {
	const statePath = statePathOf(config);
	const described = describeState(d.readState(statePath), limitsOf(config), d.now());
	const configured = seedCredName(config) !== undefined;
	if (rest.includes("--json")) {
		d.log(JSON.stringify({ configured, statePath, ...described, unlockCommand: "sudo gh-broker otp unlock" }, null, "\t"));
	} else {
		for (const line of formatStatus(described, { statePath, configured })) d.log(line);
	}
	return 0;
}

function unlock(config, d) {
	const statePath = statePathOf(config);
	const read = d.readState(statePath);
	if (read.status === "missing") {
		d.log(`nothing to unlock: no state file at ${statePath}`);
		return 0;
	}
	const wasCorrupt = read.status === "corrupt";
	const before = describeState(read, limitsOf(config), d.now());
	d.writeState(statePath, unlockedState(read.state));
	d.log(wasCorrupt ? `rewrote the corrupt state file at ${statePath}; the broker is unlocked` : before.locked ? `unlocked ${statePath}` : `${statePath} was not locked; counters cleared`);
	return 0;
}

async function rotate(config, d) {
	const name = seedCredName(config);
	if (!name) throw new Error("OTP is not configured (no otp.seed in the config); re-run the installer first");
	const seed = d.newSeed ? d.newSeed() : generateSeed();
	d.storeSeed(config, name, seed);
	await showSeed({ seed, host: d.host(), log: d.log, ...(d.qr ? { qr: d.qr } : {}) });
	d.restart();
	d.log("service restarted. The old authenticator entry no longer works; remove it from your app.");
	return 0;
}
