/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /deploy/lib/credentials.mjs
 *	@Date: 2026-10-31T12:53:32-07:00 (1793476412)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-31T12:58:15-07:00 (1793476695)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Where each credential's value comes from, and what gets stored, for the installer's
 * secrets step. Kept out of install.mjs (which needs root and a systemd host) so the
 * decisions are testable; the filesystem and systemd operations are passed in.
 *
 * Precedence for a value: explicit (--secret, then --secrets-file, then env
 * GH_BROKER_SECRET_<NAME>) → a newly created npm token (when this run creates one) → the
 * plaintext secrets file → decrypting an existing .cred → an interactive prompt. An explicit
 * value, or a newly created token, replaces a stored one (rotation); otherwise a stored value
 * is kept. Optional credentials (their tools are hidden without them) can be skipped and never
 * fail the install. Every problem throws; install.mjs reports it and exits.
 */

import { envSecretKey } from "./install-args.mjs";

/**
 * @param {object} o
 * @param {string[]} o.needed                   every cred name the config references
 * @param {Set<string>} o.optional              the ones that may be missing
 * @param {Record<string, string>} o.cliSecrets --secret values
 * @param {Record<string, unknown>} o.imported  --secrets-file contents ({} when none)
 * @param {Record<string, string | undefined>} o.env
 * @param {Record<string, string>} o.existingFile current plaintext secrets file ({} when none)
 * @param {(name: string) => string | undefined} o.decrypt  an existing .cred's value, if any
 * @param {(name: string) => boolean} o.mints   whether this run creates `name` (the npm token)
 * @param {(name: string) => Promise<string>} o.mint
 * @param {string | undefined} o.appKeyName     the App private key (multi-line; can't be prompted)
 * @param {boolean} o.nonInteractive
 * @param {(q: string) => Promise<string>} o.promptHidden
 * @param {(m: string) => void} o.log
 */
export function credentialPlan(o) {
	const unknown = Object.keys(o.cliSecrets).filter((n) => !o.needed.includes(n));
	if (unknown.length) throw new Error(`--secret names no credential this config uses: ${unknown.join(", ")} (it uses: ${o.needed.join(", ")})`);

	const explicit = (name) => {
		for (const v of [o.cliSecrets[name], o.imported?.[name], o.env[envSecretKey(name)]]) {
			if (typeof v === "string" && v) return v;
		}
		return undefined;
	};
	const minting = (name) => o.mints(name) && explicit(name) === undefined;
	/** A new value is supplied for this run, so a stored one is replaced. */
	const replaces = (name) => explicit(name) !== undefined || minting(name);

	/** The value for `name`, or undefined for a skipped optional credential. */
	const resolve = async (name) => {
		const given = explicit(name);
		if (given) return given;
		if (minting(name)) {
			if (o.nonInteractive) throw new Error(`creating the npm token needs a browser login and prompts — run interactively, or supply an existing token via --secret, --secrets-file or env ${envSecretKey(name)}`);
			return o.mint(name);
		}
		const fromFile = o.existingFile[name];
		if (typeof fromFile === "string" && fromFile) return fromFile;
		const dec = o.decrypt(name);
		if (dec) {
			o.log(`  ${name}: migrated from systemd-creds`);
			return dec;
		}
		if (o.optional.has(name)) {
			if (o.nonInteractive) return undefined;
			return (await o.promptHidden(`  ${name} (input hidden; Enter to skip — its tools stay hidden): `)) || undefined;
		}
		if (o.nonInteractive) throw new Error(`missing credential "${name}" — provide via --secret, --secrets-file or env ${envSecretKey(name)}`);
		if (name === o.appKeyName) {
			throw new Error(`credential "${name}" is a GitHub App private key (multi-line PEM); the single-line prompt can't accept it — supply it via --secrets-file or env ${envSecretKey(name)}`);
		}
		const entered = await o.promptHidden(`  ${name} (input hidden): `);
		if (!entered) throw new Error(`empty value for "${name}"`);
		return entered;
	};

	const skipped = (name) => o.log(`  ${name}: not stored — its tools stay hidden until it is (re-run the installer to add it)`);
	const replacedNote = (name) => {
		if (minting(name)) o.log(`  note: the previous ${name} is still valid until it expires — revoke it in your npm account's Access Tokens settings`);
	};

	/**
	 * systemd-creds backend. Returns the names that end up stored: only those go into the
	 * LoadCredentialEncrypted= drop-in, since a line for a missing file stops the unit.
	 * @param {{ exists: (name: string) => boolean, encrypt: (name: string, value: string) => void }} io
	 */
	const storeSystemd = async (io) => {
		const stored = [];
		for (const name of o.needed) {
			const existed = io.exists(name);
			// A plaintext entry (file → creds migration) or a new value re-encrypts; otherwise keep.
			if (existed && !o.existingFile[name] && !replaces(name)) {
				o.log(`  ${name}: existing systemd-creds kept`);
				stored.push(name);
				continue;
			}
			// Only a missing optional cred can resolve to nothing here: a re-encrypt always has a
			// value (the explicit one, the new npm token, or the plaintext entry).
			const value = await resolve(name);
			if (value === undefined) {
				skipped(name);
				continue;
			}
			io.encrypt(name, value);
			stored.push(name);
			o.log(`  ${name}: ${existed ? "rotated" : "encrypted"} (systemd-creds)`);
			if (existed) replacedNote(name);
		}
		return stored;
	};

	/** file backend: the token map to write. */
	const storeFile = async () => {
		const tokens = { ...o.existingFile };
		for (const name of o.needed) {
			if (tokens[name] && !replaces(name)) continue;
			const had = Boolean(tokens[name]);
			// As above, only a missing optional cred can resolve to nothing.
			const value = await resolve(name);
			if (value === undefined) {
				skipped(name);
				continue;
			}
			tokens[name] = value;
			if (had) replacedNote(name);
		}
		return tokens;
	};

	return { explicit, replaces, resolve, storeSystemd, storeFile };
}
