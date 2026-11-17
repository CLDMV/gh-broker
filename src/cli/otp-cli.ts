/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/otp-cli.ts
 *	@Date: 2026-11-02T09:12:00-08:00 (1793639520)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T08:30:08-08:00 (1794673808)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * `gh-broker otp unlock | status | list | rotate` (#143, contract v2): the root-side half of the OTP gate.
 * Lock state is per agent user, in the state file the daemon writes. Every effect is injected (see
 * src/cli/real-deps.ts for the real wiring), so the commands are testable without root.
 */
import type { OtpState } from "../otp/state.ts";
import type { ConfigLayer } from "./config-merge.ts";
import type { Group } from "./agents.ts";
import type { StateReading } from "./otp.ts";
import { parseOtpOptions, stepOtp } from "@cldmv/lib-otp";
import { DEFAULT_STATE_PATH, DEFAULT_MAX_FAILURES, DEFAULT_MAX_LOCKOUTS, describeUsers, emptyState, formatStatus, generateSeed, personOf, secondsUntilFreshCode, seedCredName, showSeed, spendRecentCodes, userOf, withoutUser, withoutUsers } from "./otp.ts";
import { assertAgentName, registeredAgents, versionWarning } from "./agents.ts";

/**
 * The machine the CLI drives its unlock event through. The daemon's own machine config maps
 * config.otp explicitly (src/otp/gate.ts machineConfig); the unlock's outcome and the global
 * spend don't read any of the mapped limits — the period and skew are the daemon's fixed
 * 30 s/±1 — so the defaults are the same machine.
 */
const UNLOCK_MACHINE = parseOtpOptions();

/** The effects the `otp` commands use. */
export interface OtpDeps {
	log: (line: string) => void;
	error: (line: string) => void;
	now: () => number;
	host: () => string;
	groups: () => Group[];
	readState: (path: string) => StateReading;
	writeState: (path: string, state: OtpState) => void;
	versions: () => { pkg: string | undefined; deployed: string | undefined };
	/** Journal entry for an unlock (never fatal when it fails). */
	audit: (entry: { ts: string; decision: "otp-unlock"; user: string; by: string; detail?: string }) => void;
	sudoUser: () => string | undefined;
	/** Replaces the seed generator (tests). */
	newSeed?: () => string;
	/** Replaces the QR renderer (tests). */
	qr?: (uri: string) => Promise<string>;
	storeSeed: (config: ConfigLayer, name: string, seed: string) => unknown;
	restart: () => void;
}

export const statePathOf = (config: ConfigLayer): string => config.otp?.statePath ?? DEFAULT_STATE_PATH;
export const limitsOf = (config: ConfigLayer): { maxFailures: number; maxLockouts: number } => ({ maxFailures: config.otp?.maxFailures ?? DEFAULT_MAX_FAILURES, maxLockouts: config.otp?.maxLockouts ?? DEFAULT_MAX_LOCKOUTS });

/** Run one `otp` subcommand. Returns the exit code; throws on a failure the dispatcher reports. */
export async function otpCommand(command: string, rest: string[], config: ConfigLayer, d: OtpDeps): Promise<number> {
	if (command === "status") return status(config, rest, d);
	if (command === "unlock") return unlock(config, rest, d);
	if (command === "list") return list(config, rest, d);
	return rotate(config, d);
}

function status(config: ConfigLayer, rest: string[], d: OtpDeps): number {
	const only = rest.find((a) => !a.startsWith("-"));
	const statePath = statePathOf(config);
	const read = d.readState(statePath);
	const known = registeredAgents(d.groups()).map((a) => a.user);
	const users = describeUsers(read, only ? [only] : known, limitsOf(config), d.now()).filter((u) => !only || u.user === only);
	const configured = seedCredName(config) !== undefined;
	const warn = versionWarning(d.versions().pkg, d.versions().deployed);
	if (rest.includes("--json")) {
		d.log(JSON.stringify({ configured, statePath, fileStatus: read.status, users, unlockCommand: "sudo gh-broker otp unlock <user>" }, null, "\t"));
	} else {
		for (const line of formatStatus(users, { statePath, fileStatus: read.status, configured })) d.log(line);
	}
	if (warn) d.error(warn);
	return 0;
}

/** Who is locked out right now (short lockout or hard lock), with the command that clears each. */
function list(config: ConfigLayer, rest: string[], d: OtpDeps): number {
	const statePath = statePathOf(config);
	const read = d.readState(statePath);
	const known = registeredAgents(d.groups()).map((a) => a.user);
	const locked = describeUsers(read, known, limitsOf(config), d.now())
		.filter((u) => u.locked)
		.map((u) => ({ user: u.user, corrupt: Boolean(u.corrupt), hardLock: u.hardLock, lockedUntil: u.lockedUntil, unlockCommand: u.corrupt ? "sudo gh-broker otp unlock --all" : `sudo gh-broker otp unlock ${u.user}` }));
	if (rest.includes("--json")) {
		d.log(JSON.stringify({ statePath, fileStatus: read.status, locked }, null, "\t"));
		return 0;
	}
	if (locked.length === 0) d.log("nobody is locked out");
	for (const u of locked) {
		const why = u.corrupt ? `locked: ${statePath} is corrupt` : u.hardLock ? `hard-locked since ${u.hardLock.since} after ${u.hardLock.lockouts} lockouts` : `locked until ${u.lockedUntil}`;
		d.log(`${u.user}  ${why}  unlock: ${u.unlockCommand}`);
	}
	return 0;
}

/** Record an unlock in the journal next to the daemon's audit log (never fatal). */
function auditUnlock(d: OtpDeps, user: string, detail?: string): void {
	try {
		d.audit({ ts: new Date(d.now()).toISOString(), decision: "otp-unlock", user, by: d.sudoUser() || "root", ...(detail ? { detail } : {}) });
	} catch (err) {
		d.error(`warning: the unlock could not be written to the journal: ${(err as Error).message}`);
	}
}

/** What to tell the operator after a write that spent the recent codes (a code that is refused counts as a bad one). */
const afterUnlock = (now: number): string => `The code the authenticator shows now won't work, nor the one after it: wait ${secondsUntilFreshCode(now)} s for a fresh code.`;

function unlock(config: ConfigLayer, rest: string[], d: OtpDeps): number {
	const all = rest.includes("--all");
	const user = rest.find((a) => !a.startsWith("-"));
	if (all === Boolean(user)) throw new Error('name the agent to unlock ("sudo gh-broker otp unlock <user>") or pass --all');
	if (user) assertAgentName(user);
	const statePath = statePathOf(config);
	const read = d.readState(statePath);
	if (read.status === "missing") {
		d.log(`nothing to unlock: no state file at ${statePath}`);
		return 0;
	}
	const now = d.now();
	if (read.status === "corrupt") {
		if (!all) throw new Error(`${statePath} is corrupt, so every user is locked; run "sudo gh-broker otp unlock --all" to rewrite it clean`);
		// The old lastAcceptedStep can't be read back, so spend everything up to now instead.
		d.writeState(statePath, spendRecentCodes(emptyState(), now));
		auditUnlock(d, "*", "rewrote a corrupt state file");
		d.log(`rewrote the corrupt state file at ${statePath}; everyone is unlocked. ${afterUnlock(now)}`);
		return 0;
	}
	if (all) {
		d.writeState(statePath, spendRecentCodes(withoutUsers(read.state), now));
		auditUnlock(d, "*");
		d.log(`cleared the lock state of every user in ${statePath}. ${afterUnlock(now)}`);
		return 0;
	}
	if (!Object.hasOwn(read.state.users, user!)) {
		d.log(`${user} has no lock state; nothing to clear`);
		return 0;
	}
	// The unlock runs through the machine's admin-unlock event (its spend lands on the record's
	// own counter, which is discarded here — the entry is deleted outright — and the global step
	// is spent below, which is the spend that matters across users). Today's outcome keys off the
	// entry's existence rather than the record's emptiness, so a machine "no-entry" for an
	// all-zero entry still clears it.
	const { outcome } = stepOtp(personOf(userOf(read.state, user!)), { kind: "admin-unlock", by: d.sudoUser() || "root", now }, UNLOCK_MACHINE);
	const result = outcome?.reason === "unlocked" ? `unlocked ${user}` : `cleared ${user}'s counters (not hard-locked)`;
	d.writeState(statePath, spendRecentCodes(withoutUser(read.state, user!), now));
	auditUnlock(d, user!);
	d.log(`${result}. ${afterUnlock(now)}`);
	return 0;
}

async function rotate(config: ConfigLayer, d: OtpDeps): Promise<number> {
	const name = seedCredName(config);
	if (!name) throw new Error("OTP is not configured (no otp.seed in the config); re-run the installer first");
	const seed = d.newSeed ? d.newSeed() : generateSeed();
	// Shown before it is stored: storing replaces the old seed, so a failure after the store
	// would otherwise leave a seed nobody has.
	await showSeed({ seed, host: d.host(), log: d.log, ...(d.qr ? { qr: d.qr } : {}) });
	try {
		d.storeSeed(config, name, seed);
	} catch (err) {
		throw new Error(`storing the new seed failed (${(err as Error).message}); the key above is not in use and the old seed is still the stored one. Nothing was restarted; run "sudo gh-broker otp rotate" again`);
	}
	d.restart();
	d.log("service restarted. The old authenticator entry no longer works; remove it from your app.");
	return 0;
}
