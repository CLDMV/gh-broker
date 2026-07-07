/**
 * Config + internal types for gh-broker.
 *
 * The on-disk config (`/etc/gh-broker/config.json`) holds no secrets — only the
 * tool allowlist and, per owner, the *names* of the credentials to use. Actual
 * PAT values are resolved at runtime from systemd-delivered creds (see secrets.ts).
 */

export type Mode = "read" | "write";

/** One entry in the default-deny allowlist. `custom` verbs are handled locally, not proxied. */
export interface ToolRule {
	name: string;
	mode: Mode;
	custom?: boolean;
}

/** Credential *references* (e.g. "cred:cldmv-read"), resolved via the SecretStore. */
export interface OwnerCreds {
	read: string;
	write: string;
}

export interface Config {
	/** e.g. "unix:/run/gh-broker/gh-broker.sock" */
	listen: string;
	/** GitHub hosted MCP base URL, e.g. "https://api.githubcopilot.com/mcp/" */
	upstream: string;
	tools: ToolRule[];
	owners: Record<string, OwnerCreds>;
}

/** Resolves a "cred:<name>" reference to a token, never logging it. */
export interface SecretStore {
	resolve(ref: string): string;
}
