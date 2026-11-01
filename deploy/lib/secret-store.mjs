/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /deploy/lib/secret-store.mjs
 *	@Date: 2026-09-06T10:05:35-07:00 (1788714335)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-31T12:12:11-07:00 (1793473931)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { writeFileSync, chmodSync, chownSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";

/**
 * Write the secrets map ({ "<name>": "<token>" }) to `path` as JSON, mode 0640,
 * owned by uid:gid (root:<service-group>) so the service user reads it and the
 * agent user (not in that group, dir 0750) cannot. The file provider counterpart
 * to src/secrets.ts. Never logs a value.
 */
export function writeSecretsFile(path, secrets, { uid = 0, gid, mode = 0o640 } = {}) {
	const json = JSON.stringify(secrets, null, "\t") + "\n";
	writeFileSync(path, json, { mode });
	chmodSync(path, mode);
	if (gid !== undefined) chownSync(path, uid, gid);
}

/**
 * Read an existing secrets file so an upgrade preserves tokens the operator isn't
 * re-entering. Returns {} if the file is absent or unreadable.
 */
export function readSecretsFile(path) {
	if (!existsSync(path)) return {};
	try {
		const v = JSON.parse(readFileSync(path, "utf8"));
		if (!v || typeof v !== "object" || Array.isArray(v)) return {};
		// Keep only non-empty string values — a non-string (number/object) must never
		// be treated as a token (it would crash encryption or be written back invalid).
		const out = {};
		for (const [name, val] of Object.entries(v)) if (typeof val === "string" && val.length > 0) out[name] = val;
		return out;
	} catch {
		return {};
	}
}

/**
 * Remove a plaintext secrets file — used when the operator switches to the
 * systemd-creds provider, so the tokens don't linger on disk and defeat
 * "encrypted at rest". Best-effort zero-overwrite before unlink. No-op if absent.
 */
export function removeSecretsFile(path) {
	if (!existsSync(path)) return;
	try {
		writeFileSync(path, Buffer.alloc(statSync(path).size, 0));
	} catch {
		// overwrite is best-effort; unlink still happens below
	}
	rmSync(path, { force: true });
}

const SAFE_CRED_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Constrain a credential name to a safe charset — it becomes a `.cred` filename
 * and is interpolated into a systemd drop-in line written as root, so a name with
 * path separators, "..", colons, or control characters must be rejected.
 */
export function assertSafeCredName(name) {
	if (name === "." || name === ".." || !SAFE_CRED_NAME.test(name)) {
		throw new Error(`gh-broker: unsafe credential name "${name}" (allowed: letters, digits, ".", "_", "-")`);
	}
	return name;
}

/**
 * The distinct cred names a config's owners, app and ghcr owners reference (strips the "cred:"
 * prefix). Validates each name — this is the single source feeding the encrypted
 * `.cred` filenames and the systemd drop-in, so hardening here covers both.
 */
export function referencedCredNames(config) {
	const names = new Set();
	const add = (ref) => {
		if (typeof ref === "string" && ref.startsWith("cred:")) names.add(assertSafeCredName(ref.slice("cred:".length)));
	};
	for (const owner of Object.values(config.owners ?? {})) {
		add(owner.read);
		add(owner.write);
	}
	if (config.app) add(config.app.privateKey);
	if (config.npm) add(config.npm.token);
	for (const owner of Object.values(config.ghcr?.owners ?? {})) add(owner.credential);
	return [...names];
}

/**
 * The referenced cred names that are OPTIONAL: the broker hides the tools that need them
 * when they aren't stored (src/availability.ts) instead of refusing to start, so the
 * installer may skip them: the npm token and the GHCR credentials. The owners' PATs and
 * the App key stay required.
 */
export function optionalCredNames(config) {
	const names = [];
	const add = (ref) => {
		if (typeof ref === "string" && ref.startsWith("cred:")) names.push(assertSafeCredName(ref.slice("cred:".length)));
	};
	add(config.npm?.token);
	for (const owner of Object.values(config.ghcr?.owners ?? {})) add(owner.credential);
	return names;
}

/**
 * Works out which secrets backend an EXISTING install already uses, so a re-run keeps it
 * instead of asking again. Precedence: the provider recorded in the deployed config, then
 * what is actually on disk (encrypted `.cred` files → systemd-creds; tokens in the secrets
 * file → file). Returns undefined when it is a first install, or when both backends have
 * credentials and nothing is recorded (ambiguous — the caller should ask).
 *
 * @param {{ configured?: unknown, credNames?: string[], fileTokenNames?: string[] }} found
 * @returns {"systemd-creds" | "file" | undefined}
 */
export function detectSecretsProvider({ configured, credNames = [], fileTokenNames = [] } = {}) {
	if (configured === "systemd-creds" || configured === "file") return configured;
	const hasCreds = credNames.length > 0;
	const hasFile = fileTokenNames.length > 0;
	if (hasCreds && !hasFile) return "systemd-creds";
	if (hasFile && !hasCreds) return "file";
	return undefined;
}
