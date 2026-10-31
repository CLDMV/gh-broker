/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/types.ts
 *	@Date: 2026-07-07T00:24:51-07:00 (1783409091)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-31T11:23:23-07:00 (1793471003)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Config + internal types for gh-broker.
 *
 * The on-disk config holds no secrets — only the tool allowlist and, per owner,
 * the *names* of the credentials to use. Actual PAT values are resolved at
 * runtime from a separate, agent-unreadable secrets store (see secrets.ts and
 * docs/deploy-architecture.md). Keeping the config token-free is what makes it
 * safe to copy between machines.
 */

export type Mode = "read" | "write";

/**
 * One entry in the default-deny allowlist. `custom` verbs are handled locally, not
 * proxied. `augment` tools ARE proxied (forwarded to the hosted MCP) but the router
 * post-processes the response afterward — gh-broker's own MCP contract for a proxied
 * tool is not required to match the hosted MCP's exact schema/response verbatim (see
 * router.ts's dispatchAugmented). `custom` and `augment` are mutually exclusive.
 */
export interface ToolRule {
	name: string;
	mode: Mode;
	custom?: boolean;
	augment?: boolean;
}

/** Credential *references* (e.g. "cred:cldmv-read"), resolved via the SecretStore. */
export interface OwnerCreds {
	read: string;
	write: string;
	/**
	 * GitHub App installation id for this owner. Required only for verbs that need
	 * an App token (currently `link_issue` → addClosingIssueReference, which is not
	 * available to fine-grained PATs). Omit if the owner has no App installed.
	 */
	installationId?: number;
}

/** GitHub App config — for App-token-only operations (`link_issue`). Optional. */
export interface AppConfig {
	appId: number;
	/** Credential reference (e.g. "cred:gh-app-key") for the App's PEM private key. */
	privateKey: string;
}

/**
 * Where the actual token values live — chosen at install time. A provider seam:
 *   - "systemd-creds" (default): encrypted, host-bound `.cred` files via
 *     LoadCredentialEncrypted → $CREDENTIALS_DIRECTORY (encrypted at rest, not portable).
 *   - "file": a JSON `{ "<name>": "<token>" }` map at an agent-unreadable path
 *     (plaintext at rest, portable, platform-neutral).
 * Further providers (OS keychain, DPAPI, encrypted vault) can be added here
 * without touching call sites. Omit to use the systemd-creds provider.
 */
export interface SecretsConfig {
	provider?: "systemd-creds" | "file";
	/** For provider "file": path to the JSON secrets file. Defaults to <configDir>/secrets.json. */
	path?: string;
}

/**
 * npm integration for `npm_scaffold`. Optional: without it the verb refuses. The token is a
 * granular access token created by the installer without 2FA bypass, so every write it makes
 * still needs a user-supplied one-time password.
 */
export interface NpmConfig {
	/** Credential reference (e.g. "cred:npm-token") for the granular access token. */
	token: string;
	/** Scopes the verb may create packages in, e.g. ["@cldmv"]. */
	scopes: string[];
	/** Registry base URL. Defaults to https://registry.npmjs.org. */
	registry?: string;
	/** Installer only: npm orgs the token is also granted org read-write on when it is created. */
	tokenOrgs?: string[];
}

export interface Config {
	/** e.g. "unix:/run/gh-broker/gh-broker.sock" */
	listen: string;
	/** GitHub hosted MCP base URL, e.g. "https://api.githubcopilot.com/mcp/" */
	upstream: string;
	tools: ToolRule[];
	owners: Record<string, OwnerCreds>;
	/**
	 * Owner whose READ PAT handles calls that carry no owner in their args —
	 * the genuinely global/identity reads (global security-advisory DB, `get_me`,
	 * `list_notifications`). Must be a key of `owners`. Applies to `mode: "read"`
	 * only; write calls always require an explicit owner. Omit to reject every
	 * owner-less call (the stricter original behaviour).
	 */
	defaultOwner?: string;
	/**
	 * Optional GitHub App, reserved for `link_issue` (an App-token-only mutation).
	 * `link_issue` is currently deferred — it is neither advertised nor dispatched —
	 * so providing this does not enable any verb today.
	 */
	app?: AppConfig;
	/** Optional secret-store backend selection. Defaults to the systemd-creds provider. */
	secrets?: SecretsConfig;
	/** Optional npm integration (`npm_scaffold`). */
	npm?: NpmConfig;
}

/** Resolves a "cred:<name>" reference to a token, never logging it. */
export interface SecretStore {
	resolve(ref: string): string;
}
