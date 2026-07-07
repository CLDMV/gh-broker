import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, SecretStore } from "./types.ts";

const CRED_PREFIX = "cred:";

/**
 * Loads PATs from systemd-delivered credentials.
 *
 * `LoadCredentialEncrypted=` decrypts each cred into $CREDENTIALS_DIRECTORY/<name>
 * (a tmpfs, service-user-readable only) at start. We read them once into memory
 * and never write them anywhere or log them.
 *
 * A ref is "cred:<name>" → $CREDENTIALS_DIRECTORY/<name>.
 */
export function loadSecretStore(config: Config): SecretStore {
	const dir = process.env.CREDENTIALS_DIRECTORY;
	if (!dir) {
		throw new Error("secrets: $CREDENTIALS_DIRECTORY unset — run under systemd with LoadCredentialEncrypted=");
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

	// Eagerly validate every referenced credential exists, so a missing PAT fails
	// at startup (loud) rather than on the first request (silent 500s).
	for (const [owner, creds] of Object.entries(config.owners)) {
		for (const ref of [creds.read, creds.write]) {
			if (!ref.startsWith(CRED_PREFIX)) throw new Error(`secrets: owner "${owner}" ref must be "cred:<name>", got "${ref}"`);
			read(ref.slice(CRED_PREFIX.length));
		}
	}

	return {
		resolve(ref: string): string {
			if (!ref.startsWith(CRED_PREFIX)) throw new Error(`secrets: bad credential ref "${ref}"`);
			return read(ref.slice(CRED_PREFIX.length));
		}
	};
}
