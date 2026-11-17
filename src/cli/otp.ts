/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/cli/otp.ts
 *	@Date: 2026-11-01T20:43:03-08:00 (1793594583)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T07:38:51-08:00 (1794670731)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The installer/CLI half of the OTP gate (#143): the TOTP seed (generation, otpauth URI, the
 * one-time reveal), where it is stored, and the shared state file the daemon writes and the
 * root CLI edits. Everything here is a plain function with its effects passed in, so it is
 * testable without root or systemd. The daemon side lives in src/ and reads the same state
 * file format (version 1, per-user counters under `users`) — whose helpers (the validators,
 * the copy accessor, the spend/clear transforms and the `otp status` prose) have one
 * implementation in src/otp/state.ts, re-exported here at this module's old path.
 */
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import type { OtpConfig, SecretsConfig } from "../types.ts";
import { emptyState, validState, type OtpState, type StateReading } from "../otp/state.ts";
import { OTP_DEFAULTS } from "../otp/policy.ts";
import { base32Encode } from "../otp/totp.ts";
import { newSeed, otpauthUri as libOtpauthUri, renderQr as libRenderQr } from "@cldmv/lib-otp";
import { readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync, fchmodSync, fchownSync, statSync, constants } from "node:fs";
import { dirname, join, basename } from "node:path";
import QRCode from "qrcode";

export {
	DEFAULT_MAX_FAILURES,
	DEFAULT_MAX_LOCKOUTS,
	describeUser,
	describeUsers,
	emptyState,
	emptyUser,
	formatStatus,
	personOf,
	secondsUntilFreshCode,
	spendRecentCodes,
	userOf,
	validState,
	validUser,
	withoutUser,
	withoutUsers
} from "../otp/state.ts";
export type { OtpLimits, StateReading, UserFacts, UserStatus } from "../otp/state.ts";

export const DEFAULT_SEED_CRED = "otp-seed";
/** The state file's default location — OTP_DEFAULTS.statePath is its one home (src/otp/policy.ts). */
export const DEFAULT_STATE_PATH = OTP_DEFAULTS.statePath;
// base32Encode moved to src/otp/totp.ts (the one RFC 4648 encoder); re-exported below
// at this path for the existing import sites.
export { base32Encode };

/** A new TOTP seed: 20 random bytes as base32 (32 characters). `random` is injectable for tests. */
export function generateSeed(random: (size: number) => Uint8Array = randomBytes): string {
	// The package's newSeed: same 20 bytes → base32, with the RFC 4226 §4 floor enforced.
	return newSeed({ seedBytes: 20, random });
}

/** The otpauth URI an authenticator app imports (HMAC-SHA1, 6 digits, 30 s step). */
export function otpauthUri(seed: string, host: string): string {
	// The package's otpauthUri with the daemon's issuer and the host as the account label; it
	// builds the same URI and validates the seed as base32 first (a raw seed like "not&valid"
	// would otherwise inject a URI parameter).
	return libOtpauthUri(seed, host, "gh-broker");
}

/** The URI as a terminal QR code. `toString` is the qrcode library's, injectable for tests. */
export async function renderQr(uri: string, toString: (text: string, options: { type: "terminal"; small: boolean }) => Promise<string> = QRCode.toString): Promise<string> {
	return (await libRenderQr(uri, { toString: toString as (text: string, options: Record<string, unknown>) => Promise<string> })) as string;
}

/**
 * The one-time reveal: QR, the base32 key as text, and the URI. This is the only place the seed
 * is printed; callers hand it a `log` that writes to the operator's terminal and nowhere else.
 */
export async function showSeed({
	seed,
	host,
	log,
	qr = renderQr
}: {
	seed: string;
	host: string;
	log: (line: string) => void;
	qr?: (uri: string) => Promise<string>;
}): Promise<void> {
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
export function seedCredName(config: { otp?: Partial<OtpConfig> } | undefined): string | undefined {
	const ref = config?.otp?.seed;
	return typeof ref === "string" && ref.startsWith("cred:") ? ref.slice("cred:".length) : undefined;
}

/** Whether a stored seed already exists in the active backend (an existing one is never overwritten on install). */
export function seedExists({ name, existingFile, credFileExists }: { name: string; existingFile: Record<string, string>; credFileExists: (name: string) => boolean }): boolean {
	return Boolean(existingFile[name]) || credFileExists(name);
}

/** The effects {@link storeSeed} needs. */
export interface SeedIo {
	writeSecretsFile: (path: string, secrets: Record<string, string>) => void;
	readSecretsFile: (path: string) => Record<string, string>;
	removeFile: (path: string) => void;
	encrypt: (name: string, seed: string, file: string) => void;
	rename: (from: string, to: string) => void;
	listCreds: (dir: string) => string[];
	writeDropin: (names: string[], credsDir: string) => void;
}

/**
 * Store a seed in the backend the install uses. The systemd-creds backend replaces the `.cred`
 * (atomically: the old one stays until the new one is written) and rewrites the unit drop-in so
 * the credential is delivered; the file backend sets the key in
 * the secrets file. `io` carries every effect.
 * @param o.name   credential name
 */
export function storeSeed({
	config,
	name,
	seed,
	paths,
	io
}: {
	config: { secrets?: SecretsConfig };
	name: string;
	seed: string;
	paths: { secrets: string; credsDir: string };
	io: SeedIo;
}): "file" | "systemd-creds" {
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

/**
 * Read the state file. A missing file is all-zero; an unparseable or malformed one is "corrupt"
 * (the daemon fails closed on it: every user hard-locked, so status reports that). Acceptance
 * is the daemon's parseState (src/otp/state.ts), via the re-exported validState.
 */
export function readState(path: string, read: (path: string, encoding: "utf8") => string = readFileSync): StateReading {
	let text: string;
	try {
		text = read(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", state: emptyState() };
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

/** Injectable effects of {@link writeFileAtomic}. */
export interface AtomicWriteIo {
	fchown?: (fd: number, uid: number, gid: number) => void;
	random?: (size: number) => Buffer;
	beforeRename?: () => void;
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
export function writeFileAtomic(
	path: string,
	text: string,
	{ uid, gid, mode = 0o600 }: { uid: number; gid: number; mode?: number },
	{ fchown = fchownSync, random = randomBytes, beforeRename }: AtomicWriteIo = {}
): void {
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
export function writeStateAtomic(path: string, state: OtpState, owner: { uid: number; gid: number }, io?: AtomicWriteIo): void {
	writeFileAtomic(path, JSON.stringify(state, null, "\t") + "\n", { ...owner, mode: 0o600 }, io);
}

/** Identity of one version of a file on disk ("missing" when there is none); the daemon uses the same test. */
export function fileSignature(path: string, stat: (path: string) => Pick<Stats, "ino" | "mtimeMs" | "size"> = statSync): string {
	try {
		const st = stat(path);
		return `${st.ino}:${st.mtimeMs}:${st.size}`;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		throw err;
	}
}

/** The CLI's state-file reader and writer (see {@link stateStore}). */
export interface StateStore {
	read: (path: string) => StateReading;
	write: (path: string, state: OtpState) => void;
}

/**
 * The CLI's state-file reader and writer, as a compare-and-swap: a write is abandoned when the
 * file changed after this store read it (the daemon wrote a lockout or a step meanwhile), so a
 * CLI edit never puts back data the daemon just replaced. The command then fails and is run again.
 * @param owner  the service user
 */
export function stateStore(
	owner: { uid: number; gid: number },
	{
		read = readFileSync,
		stat = statSync,
		...io
	}: { read?: (path: string, encoding: "utf8") => string; stat?: (path: string) => Pick<Stats, "ino" | "mtimeMs" | "size"> } & AtomicWriteIo = {}
): StateStore {
	const seen = new Map<string, string>();
	return {
		read(path: string): StateReading {
			seen.set(path, fileSignature(path, stat)); // before reading: a change in between fails the write, which is the safe side
			return readState(path, read);
		},
		write(path: string, state: OtpState): void {
			const expected = seen.get(path);
			const beforeRename = (): void => {
				if (fileSignature(path, stat) !== expected) throw new Error(`${path} changed while this command ran (the broker wrote to it); nothing was changed, run the command again`);
			};
			writeStateAtomic(path, state, owner, { ...io, beforeRename });
			seen.set(path, fileSignature(path, stat));
		}
	};
}

