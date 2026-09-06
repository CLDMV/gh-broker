import { platform, env } from "node:process";
import { join } from "node:path";

/**
 * Platform-neutral path resolution for the config and secrets files.
 *
 * Nothing is hardcoded to /etc. Both files resolve through the same order:
 *   1. an explicit path (a `--config` flag, or GH_BROKER_CONFIG / GH_BROKER_SECRETS),
 *   2. the platform's system config dir (below),
 *   3. the packaged default under that dir.
 *
 * Only the Linux defaults are exercised today; the macOS/Windows entries are
 * wired so a later port is a table entry, not surgery. See docs/deploy-architecture.md.
 */

/** The system-wide config directory for the current platform (env-overridable). */
export function configDir(): string {
	const override = env.GH_BROKER_CONFIG_DIR;
	if (override) return override;
	switch (platform) {
		case "darwin":
			return "/Library/Application Support/gh-broker";
		case "win32":
			return join(env.ProgramData ?? "C:\\ProgramData", "gh-broker");
		default: // linux and other unixes
			return "/etc/gh-broker";
	}
}

/**
 * Resolve the config file path: an explicit argument (from `--config`) wins,
 * then GH_BROKER_CONFIG, then `<configDir>/config.json`.
 */
export function resolveConfigPath(explicit?: string): string {
	if (explicit) return explicit;
	if (env.GH_BROKER_CONFIG) return env.GH_BROKER_CONFIG;
	return join(configDir(), "config.json");
}

/** Resolve the secrets file path: an explicit argument wins, then GH_BROKER_SECRETS, then `<configDir>/secrets.json`. */
export function resolveSecretsPath(explicit?: string): string {
	if (explicit) return explicit;
	if (env.GH_BROKER_SECRETS) return env.GH_BROKER_SECRETS;
	return join(configDir(), "secrets.json");
}
