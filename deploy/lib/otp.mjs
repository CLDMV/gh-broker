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
import { readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync, fchmodSync, fchownSync, statSync, constants } from "node:fs";
import { dirname, join, basename } from "node:path";
import QRCode from "qrcode";
import { validAgentName } from "./agents.mjs";

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
 * (atomically: the old one stays until the new one is written) and rewrites the unit drop-in so
 * the credential is delivered; the file backend sets the key in
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
	// Encrypt to a side file and rename it over the old one, so a failed encrypt leaves the old
	// seed (and the unit's LoadCredentialEncrypted) intact. systemd-creds won't overwrite a file,
	// so a leftover side file from an earlier failure is removed first.
	const credFile = join(paths.credsDir, `${name}.cred`);
	const next = `${credFile}.new`;
	io.removeFile(next);
	io.encrypt(name, seed, next);
	io.rename(next, credFile);
	const names = new Set(io.listCreds(paths.credsDir));
	names.add(name);
	io.writeDropin([...names].sort(), paths.credsDir);
	return "systemd-creds";
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

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
		isCount(v.failures) &&
		(v.lockedUntil === null || isIso(v.lockedUntil)) &&
		Array.isArray(v.lockouts) &&
		v.lockouts.every(isIso) &&
		(v.hardLock === null || (isObject(v.hardLock) && isIso(v.hardLock.since) && isCount(v.hardLock.lockouts)))
	);
}

/** Whether `v` is a well-formed version 1 state object, by the same rules as the daemon's parseState (src/otp/state.ts). */
export function validState(v) {
	return isObject(v) && v.version === 1 && isCount(v.lastAcceptedStep) && isObject(v.users) && Object.entries(v.users).every(([name, u]) => validAgentName(name) && validUser(u));
}

/** A user's entry, or all-zero when it has none. */
export function userOf(state, user) {
	return Object.hasOwn(state.users, user) ? state.users[user] : emptyUser();
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

/**
 * `state` ready to be written by the CLI: every code up to one step ahead of `now` counts as
 * spent. The CLI rewrites the whole file while the daemon may be accepting a code (it accepts
 * at most one step ahead), so this keeps a write from handing back a code the daemon just used.
 * The cost is that the code an authenticator shows now, and the one after it, can't open a
 * window; see secondsUntilFreshCode.
 */
export function spendRecentCodes(state, now) {
	return { ...state, lastAcceptedStep: Math.max(state.lastAcceptedStep, Math.floor(now / 30000) + 1) };
}

/** Seconds from `now` until an authenticator shows a code spendRecentCodes(…, now) didn't spend (31 to 60). */
export function secondsUntilFreshCode(now) {
	return Math.ceil(((Math.floor(now / 30000) + 2) * 30000 - now) / 1000);
}

/** The state with every user cleared. */
export function withoutUsers(state) {
	return { ...state, users: {} };
}

/**
 * Write a file atomically: a temp file in the same directory, fsync, rename; the given mode,
 * chowned to uid:gid. The directory can belong to someone else (an agent user's home), so the
 * temp file has a random name and is opened with O_EXCL|O_NOFOLLOW (never an existing file or a
 * planted symlink), and the mode and owner are set on the open descriptor, not the path. The
 * rename replaces a symlink at `path` rather than following it. `beforeRename`, when given, runs
 * just before the rename and can throw to abandon the write. `fchown` (it needs root) and
 * `random` are injectable for tests.
 */
export function writeFileAtomic(path, text, { uid, gid, mode = 0o600 }, { fchown = fchownSync, random = randomBytes, beforeRename } = {}) {
	const tmp = join(dirname(path), `.${basename(path)}.${random(8).toString("hex")}.tmp`);
	const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		try {
			fchmodSync(fd, mode);
			fchown(fd, uid, gid);
			writeSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		beforeRename?.();
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

/** Identity of one version of a file on disk ("missing" when there is none); the daemon uses the same test. */
export function fileSignature(path, stat = statSync) {
	try {
		const st = stat(path);
		return `${st.ino}:${st.mtimeMs}:${st.size}`;
	} catch (err) {
		if (err.code === "ENOENT") return "missing";
		throw err;
	}
}

/**
 * The CLI's state-file reader and writer, as a compare-and-swap: a write is abandoned when the
 * file changed after this store read it (the daemon wrote a lockout or a step meanwhile), so a
 * CLI edit never puts back data the daemon just replaced. The command then fails and is run again.
 * @param {{ uid: number, gid: number }} owner  the service user
 */
export function stateStore(owner, { read = readFileSync, stat = statSync, ...io } = {}) {
	const seen = new Map();
	return {
		read(path) {
			seen.set(path, fileSignature(path, stat)); // before reading: a change in between fails the write, which is the safe side
			return readState(path, read);
		},
		write(path, state) {
			const expected = seen.get(path);
			const beforeRename = () => {
				if (fileSignature(path, stat) !== expected) throw new Error(`${path} changed while this command ran (the broker wrote to it); nothing was changed, run the command again`);
			};
			writeStateAtomic(path, state, owner, { ...io, beforeRename });
			seen.set(path, fileSignature(path, stat));
		}
	};
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
