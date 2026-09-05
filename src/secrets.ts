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

function credName(ref: string): string {
	if (!ref.startsWith(CRED_PREFIX)) throw new Error(`secrets: bad credential ref "${ref}"`);
	return ref.slice(CRED_PREFIX.length);
}

/** Eagerly read every referenced credential so a missing token fails at startup, not on first request. */
function validateRefs(config: Config, read: (name: string) => string): void {
	for (const [owner, creds] of Object.entries(config.owners)) {
		for (const ref of [creds.read, creds.write]) {
			if (!ref.startsWith(CRED_PREFIX)) throw new Error(`secrets: owner "${owner}" ref must be "cred:<name>", got "${ref}"`);
			read(ref.slice(CRED_PREFIX.length));
		}
	}
	if (config.app) {
		// The App key is a secret too — it must be a cred: ref, never inlined in the
		// token-free config. Reject a non-cred ref rather than silently accepting it.
		if (!config.app.privateKey.startsWith(CRED_PREFIX)) {
			throw new Error(`secrets: config.app.privateKey must be a "cred:<name>" ref, got "${config.app.privateKey}"`);
		}
		read(config.app.privateKey.slice(CRED_PREFIX.length));
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
		if (typeof val !== "string" || val.length === 0) {
			throw new Error(`secrets: credential "${name}" missing or empty in ${path}`);
		}
		return val;
	};
	validateRefs(config, read);
	return { resolve: (ref) => read(credName(ref)) };
}
