/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/secrets.ts
 *	@Date: 2026-07-07T00:24:51-07:00 (1783409091)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T11:30:58-07:00 (1790965858)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, SecretStore } from "./types.ts";
import { resolveSecretsPath } from "./paths.ts";

const CRED_PREFIX = "cred:";

/**
 * Loads PATs from the configured secret store and returns a resolver mapping
 * "cred:<name>" refs to token values. Never writes or logs a token.
 *
 * Provider seam (chosen at install time, recorded in config.secrets.provider):
 *   - "systemd-creds" (default) — tokens are systemd-encrypted, host/TPM-bound
 *     `.cred` files delivered via LoadCredentialEncrypted into $CREDENTIALS_DIRECTORY
 *     (memory-only, service-user-readable). Encrypted at rest; not portable.
 *   - "file" — a JSON `{ "<name>": "<token>" }` map at an agent-unreadable path.
 *     Plaintext at rest (perms only); portable and platform-neutral.
 *
 * Both keep tokens off any agent-readable path — the agent boundary is filesystem
 * perms either way. See docs/deploy-architecture.md.
 */
export function loadSecretStore(config: Config): SecretStore {
	const provider = config.secrets?.provider ?? "systemd-creds";
	switch (provider) {
		case "systemd-creds":
			return systemdCredsStore(config);
		case "file":
			return fileStore(config);
		default:
			throw new Error(`secrets: unknown provider "${provider}" (expected "systemd-creds" or "file")`);
	}
}

const SAFE_CRED_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Credential names become filesystem path components (`join(dir, name)`) and are
 * interpolated into systemd drop-in lines, so constrain them to a safe charset —
 * no path separators, "..", colons, or control characters — to prevent reads
 * outside $CREDENTIALS_DIRECTORY and malformed drop-ins.
 */
function assertSafeName(name: string): string {
	if (name === "." || name === ".." || !SAFE_CRED_NAME.test(name)) {
		throw new Error(`secrets: unsafe credential name "${name}" (allowed: letters, digits, ".", "_", "-")`);
	}
	return name;
}

function credName(ref: string): string {
	if (!ref.startsWith(CRED_PREFIX)) throw new Error(`secrets: bad credential ref "${ref}"`);
	return assertSafeName(ref.slice(CRED_PREFIX.length));
}

/** Eagerly read every referenced credential so a missing token fails at startup, not on first request. */
function validateRefs(config: Config, read: (name: string) => string): void {
	for (const [owner, creds] of Object.entries(config.owners)) {
		for (const ref of [creds.read, creds.write]) {
			if (!ref.startsWith(CRED_PREFIX)) throw new Error(`secrets: owner "${owner}" ref must be "cred:<name>", got "${ref}"`);
			read(assertSafeName(ref.slice(CRED_PREFIX.length)));
		}
	}
	if (config.app) {
		// The App key is a secret too — it must be a cred: ref, never inlined in the
		// token-free config. Reject a non-cred ref rather than silently accepting it.
		if (!config.app.privateKey.startsWith(CRED_PREFIX)) {
			throw new Error(`secrets: config.app.privateKey must be a "cred:<name>" ref, got "${config.app.privateKey}"`);
		}
		read(assertSafeName(config.app.privateKey.slice(CRED_PREFIX.length)));
	}
}

/** systemd-creds provider: read decrypted creds from $CREDENTIALS_DIRECTORY. */
function systemdCredsStore(config: Config): SecretStore {
	const dir = process.env.CREDENTIALS_DIRECTORY;
	if (!dir) {
		throw new Error("secrets: $CREDENTIALS_DIRECTORY unset — the systemd-creds provider needs LoadCredentialEncrypted= (run under systemd)");
	}
	const cache = new Map<string, string>();
	const read = (name: string): string => {
		const cached = cache.get(name);
		if (cached !== undefined) return cached;
		let val: string;
		try {
			val = readFileSync(join(dir, name), "utf8").replace(/\r?\n$/, "");
		} catch (err) {
			throw new Error(`secrets: credential "${name}" not available: ${(err as Error).message}`);
		}
		if (!val) throw new Error(`secrets: credential "${name}" is empty`);
		cache.set(name, val);
		return val;
	};
	validateRefs(config, read);
	return { resolve: (ref) => read(credName(ref)) };
}

/** file provider: read tokens from a JSON `{ "<name>": "<token>" }` map. */
function fileStore(config: Config): SecretStore {
	const path = resolveSecretsPath(config.secrets?.path);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new Error(`secrets: cannot read/parse secrets file ${path}: ${(err as Error).message}`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`secrets: ${path} must be a JSON object of { "<name>": "<token>" }`);
	}
	const map = raw as Record<string, unknown>; // read once into memory; never re-read or write

	const read = (name: string): string => {
		const val = map[name];
		if (typeof val !== "string") throw new Error(`secrets: credential "${name}" missing or empty in ${path}`);
		// Normalize like the systemd-creds provider: strip a single trailing newline
		// (common when a token is copy/pasted into the JSON) so it isn't silently
		// mismatched at auth time. A value that is only a newline then reads as empty.
		const token = val.replace(/\r?\n$/, "");
		if (token.length === 0) throw new Error(`secrets: credential "${name}" missing or empty in ${path}`);
		return token;
	};
	validateRefs(config, read);
	return { resolve: (ref) => read(credName(ref)) };
}
