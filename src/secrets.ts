import { readFileSync } from "node:fs";
import type { Config, SecretStore } from "./types.ts";
import { resolveSecretsPath } from "./paths.ts";

const CRED_PREFIX = "cred:";

/**
 * Loads PATs from the configured secret store and returns a resolver mapping
 * "cred:<name>" refs to token values. Never writes or logs a token.
 *
 * Provider seam: only "file" is implemented — a JSON `{ "<name>": "<token>" }`
 * map at an agent-unreadable path. The daemon runs as the service user and the
 * file is 0640 root:<service-group> inside a 0750 dir, so the agent user (not in
 * that group) can't read it — the same filesystem boundary that protects the
 * config. An OS-keychain / DPAPI / encrypted-vault provider can slot in here
 * without touching call sites. See docs/deploy-architecture.md.
 */
export function loadSecretStore(config: Config): SecretStore {
	const provider = config.secrets?.provider ?? "file";
	switch (provider) {
		case "file":
			return fileStore(config);
		default:
			throw new Error(`secrets: unknown provider "${provider}" (only "file" is implemented)`);
	}
}

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
	// Read once into memory; never re-read from disk or write anywhere.
	const map = raw as Record<string, unknown>;

	const read = (name: string): string => {
		const val = map[name];
		if (typeof val !== "string" || val.length === 0) {
			throw new Error(`secrets: credential "${name}" missing or empty in ${path}`);
		}
		return val;
	};

	// Eagerly validate every referenced credential exists, so a missing token fails
	// at startup (loud) rather than on the first request (silent 500s).
	for (const [owner, creds] of Object.entries(config.owners)) {
		for (const ref of [creds.read, creds.write]) {
			if (!ref.startsWith(CRED_PREFIX)) throw new Error(`secrets: owner "${owner}" ref must be "cred:<name>", got "${ref}"`);
			read(ref.slice(CRED_PREFIX.length));
		}
	}
	if (config.app && config.app.privateKey.startsWith(CRED_PREFIX)) {
		read(config.app.privateKey.slice(CRED_PREFIX.length));
	}

	return {
		resolve(ref: string): string {
			if (!ref.startsWith(CRED_PREFIX)) throw new Error(`secrets: bad credential ref "${ref}"`);
			return read(ref.slice(CRED_PREFIX.length));
		}
	};
}
