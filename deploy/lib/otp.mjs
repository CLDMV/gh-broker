/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /deploy/lib/otp.mjs
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
 * The installer/CLI half of the OTP gate (#143): the TOTP seed (generation, otpauth URI, the
 * one-time reveal), where it is stored, and the shared state file the daemon writes and the
 * root CLI edits. Everything here is a plain function with its effects passed in, so it is
 * testable without root or systemd. The daemon side lives in src/ and reads the same state
 * file format (version 1, per-user counters under `users`).
 */
import { randomBytes } from "node:crypto";
import { readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync, chmodSync, chownSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import QRCode from "qrcode";

export const DEFAULT_SEED_CRED = "otp-seed";
export const DEFAULT_STATE_PATH = "/var/lib/gh-broker/otp-state.json";
export const DEFAULT_MAX_FAILURES = 5;
export const DEFAULT_MAX_LOCKOUTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding. */
export function base32Encode(bytes) {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
	return out;
}

/** A new TOTP seed: 20 random bytes as base32 (32 characters). `random` is injectable for tests. */
export function generateSeed(random = randomBytes) {
	return base32Encode(random(20));
}

/** The otpauth URI an authenticator app imports (HMAC-SHA1, 6 digits, 30 s step). */
export function otpauthUri(seed, host) {
	return `otpauth://totp/gh-broker:${encodeURIComponent(host)}?secret=${seed}&issuer=gh-broker&algorithm=SHA1&digits=6&period=30`;
}

/** The URI as a terminal QR code. `toString` is the qrcode library's, injectable for tests. */
export async function renderQr(uri, toString = QRCode.toString) {
	return toString(uri, { type: "terminal", small: true });
}

/**
 * The one-time reveal: QR, the base32 key as text, and the URI. This is the only place the seed
 * is printed; callers hand it a `log` that writes to the operator's terminal and nowhere else.
 */
export async function showSeed({ seed, host, log, qr = renderQr }) {
	const uri = otpauthUri(seed, host);
	log("");
	log("  OTP seed (shown once). Scan the QR code with an authenticator app, or enter the key by hand:");
	log("");
	for (const line of (await qr(uri)).split("\n")) log(`  ${line}`);
	log(`  key: ${seed}`);
	log(`  uri: ${uri}`);
	log("");
	log("  Store it in the authenticator now; it is not shown again (`sudo gh-broker otp rotate` makes a new one).");
}

/** The cred name the config's `otp.seed` ref points at, or undefined when OTP isn't configured. */
export function seedCredName(config) {
	const ref = config?.otp?.seed;
	return typeof ref === "string" && ref.startsWith("cred:") ? ref.slice("cred:".length) : undefined;
}

/** Whether a stored seed already exists in the active backend (an existing one is never overwritten on install). */
export function seedExists({ name, existingFile, credFileExists }) {
	return Boolean(existingFile[name]) || credFileExists(name);
}

/**
 * Store a seed in the backend the install uses. The systemd-creds backend replaces the `.cred`
 * and rewrites the unit drop-in so the credential is delivered; the file backend sets the key in
 * the secrets file. `io` carries every effect.
 * @param {object} o
 * @param {{ secrets?: { provider?: string } }} o.config
 * @param {string} o.name         credential name
 * @param {string} o.seed
 * @param {{ secrets: string, credsDir: string }} o.paths
 * @param {object} o.io
 */
export function storeSeed({ config, name, seed, paths, io }) {
	if (config.secrets?.provider === "file") {
		io.writeSecretsFile(paths.secrets, { ...io.readSecretsFile(paths.secrets), [name]: seed });
		return "file";
	}
	const credFile = join(paths.credsDir, `${name}.cred`);
	io.removeFile(credFile); // systemd-creds will not replace an existing output file
	io.encrypt(name, seed, credFile);
	const names = new Set(io.listCreds(paths.credsDir));
	names.add(name);
	io.writeDropin([...names].sort(), paths.credsDir);
	return "systemd-creds";
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** One user's counters, all zero (what a user with no entry has). */
export function emptyUser() {
	return { failures: 0, lockedUntil: null, lockouts: [], hardLock: null };
}

/** All-zero state, the format the daemon writes (contract v2: version 1, counters per user). */
export function emptyState() {
	return { version: 1, lastAcceptedStep: 0, users: {} };
}

/** Whether `v` is a well-formed per-user entry. */
export function validUser(v) {
	return (
		isObject(v) &&
		Number.isInteger(v.failures) &&
		(v.lockedUntil === null || isIso(v.lockedUntil)) &&
		Array.isArray(v.lockouts) &&
		v.lockouts.every(isIso) &&
		(v.hardLock === null || (isObject(v.hardLock) && isIso(v.hardLock.since) && Number.isInteger(v.hardLock.lockouts)))
	);
}

/** Whether `v` is a well-formed version 1 state object. */
export function validState(v) {
	return isObject(v) && v.version === 1 && Number.isInteger(v.lastAcceptedStep) && isObject(v.users) && Object.values(v.users).every(validUser);
}

/** A user's entry, or all-zero when it has none. */
export function userOf(state, user) {
	return state.users[user] ?? emptyUser();
}

/**
 * Read the state file. A missing file is all-zero; an unparseable or malformed one is "corrupt"
 * (the daemon fails closed on it: every user hard-locked, so status reports that).
 * @returns {{ status: "ok" | "missing" | "corrupt", state: object }}
 */
export function readState(path, read = readFileSync) {
	let text;
	try {
		text = read(path, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return { status: "missing", state: emptyState() };
		throw err;
	}
	try {
		const parsed = JSON.parse(text);
		if (validState(parsed)) return { status: "ok", state: parsed };
	} catch {
		// falls through to corrupt
	}
	return { status: "corrupt", state: emptyState() };
}

/** The state with one user's entry cleared (no entry means all-zero). `lastAcceptedStep` is kept so a spent code can't be replayed. */
export function withoutUser(state, user) {
	const { [user]: _gone, ...users } = state.users;
	return { ...state, users };
}

/** The state with every user cleared. */
export function withoutUsers(state) {
	return { ...state, users: {} };
}

/**
 * Write a file atomically: a temp file in the same directory, fsync, rename; the given mode,
 * chowned to uid:gid. `chown` is injectable (it needs root).
 */
export function writeFileAtomic(path, text, { uid, gid, mode = 0o600 }, { chown = chownSync } = {}) {
	const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
	const fd = openSync(tmp, "w", mode);
	try {
		writeSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		chmodSync(tmp, mode);
		chown(tmp, uid, gid);
		renameSync(tmp, path);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
}

/** Write the state file atomically as 0600, chowned to the service user. */
export function writeStateAtomic(path, state, owner, io) {
	writeFileAtomic(path, JSON.stringify(state, null, "\t") + "\n", { ...owner, mode: 0o600 }, io);
}

/** One user's facts for `status`, from their entry and the config's limits. */
export function describeUser(user, { maxFailures = DEFAULT_MAX_FAILURES, maxLockouts = DEFAULT_MAX_LOCKOUTS } = {}, now = Date.now()) {
	const lockedUntil = user.lockedUntil && Date.parse(user.lockedUntil) > now ? user.lockedUntil : null;
	return {
		locked: Boolean(user.hardLock) || lockedUntil !== null,
		failures: user.failures,
		maxFailures,
		lockedUntil,
		lockoutsLast24h: user.lockouts.filter((t) => Date.parse(t) > now - DAY_MS).length,
		maxLockouts,
		hardLock: user.hardLock
	};
}

/**
 * The per-user facts for the given users (registered agents plus any user the file mentions).
 * A corrupt file locks every one of them, as the daemon does.
 * @returns {Array<{ user: string, corrupt?: true } & ReturnType<typeof describeUser>>}
 */
export function describeUsers({ status, state }, users, limits = {}, now = Date.now()) {
	const names = [...new Set([...users, ...Object.keys(state.users)])].sort();
	return names.map((user) =>
		status === "corrupt"
			? { user, corrupt: true, locked: true, failures: null, maxFailures: limits.maxFailures ?? DEFAULT_MAX_FAILURES, lockedUntil: null, lockoutsLast24h: null, maxLockouts: limits.maxLockouts ?? DEFAULT_MAX_LOCKOUTS, hardLock: null }
			: { user, ...describeUser(userOf(state, user), limits, now) }
	);
}

/** Human-readable lines for `describeUsers`'s result. */
export function formatStatus(users, { statePath, fileStatus, configured, unlockCommand = "sudo gh-broker otp unlock" }) {
	const lines = [`OTP configured: ${configured ? "yes" : "no (re-run the installer to set it up)"}`, `state file: ${statePath} (${fileStatus})`];
	if (fileStatus === "corrupt") lines.push("LOCKED: the state file is unreadable, so the broker treats every user as hard-locked.", `Clear it with: ${unlockCommand} --all`);
	if (users.length === 0) lines.push("no agents registered");
	for (const d of users) {
		lines.push(`${d.user}:`);
		if (d.corrupt) {
			lines.push("  locked (state file unreadable)");
			continue;
		}
		lines.push(`  bad codes so far: ${d.failures} of ${d.maxFailures}`, `  short lockouts in the last 24 h: ${d.lockoutsLast24h} of ${d.maxLockouts}`);
		if (d.hardLock) lines.push(`  HARD LOCK since ${d.hardLock.since} after ${d.hardLock.lockouts} lockouts. Clear it with: ${unlockCommand} ${d.user}`);
		else if (d.lockedUntil) lines.push(`  short lockout until ${d.lockedUntil}`);
		else lines.push("  not locked");
	}
	return lines;
}
