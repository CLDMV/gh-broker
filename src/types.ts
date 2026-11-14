/**
 *
 *	@Project: @cldmv/gh-broker
 *	@Filename: /src/types.ts
 *	@Date: 2026-07-07T00:24:51-07:00 (1783409091)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-14T11:08:19-08:00 (1794683299)
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

import type { GhcrConfig } from "./verbs/ghcr/config.ts";

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
	/**
	 * Whether the tool needs a broker OTP (#143). Overrides the built-in default in either
	 * direction; omitted means the default (src/otp/policy.ts). Never allowed on otp_status.
	 */
	otp?: boolean;
	/**
	 * Whether the tool is served. Overrides the built-in default (src/availability.ts, where a few
	 * shipped tools start disabled) in either direction; omitted means the default. A disabled tool
	 * is hidden and refused like an unlisted one. Never false on otp_status.
	 */
	enabled?: boolean;
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

/**
 * The OTP gate (#143). Optional: without it, or while its seed isn't stored, every gated
 * tool is unavailable and everything else runs as before. Defaults in src/otp/policy.ts.
 */
export interface OtpConfig {
	/** Credential reference (e.g. "cred:otp-seed") for the base32 TOTP seed. */
	seed: string;
	/** How long a window stays open after its code first passes. Default 300. */
	windowSeconds?: number;
	/** Bad codes before a short lockout. Default 5. */
	maxFailures?: number;
	/** Length of a short lockout. Default 600. */
	lockoutSeconds?: number;
	/** Short lockouts in a rolling 24 h before the hard lock. Default 3. */
	maxLockouts?: number;
	/** The persistent state file. Default /var/lib/gh-broker/otp-state.json. */
	statePath?: string;
}

export interface Config {
	/**
	 * "agents:<abs dir>", e.g. "agents:/run/gh-broker/agents": one socket per registered agent
	 * user, `<dir>/<user>.sock` (see src/agents.ts).
	 */
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
	/** Optional GHCR push policy + credentials for the ghcr_* verbs (src/verbs/ghcr/config.ts). */
	ghcr?: GhcrConfig;
	/** Optional OTP gate for risky tools (src/otp/). */
	otp?: OtpConfig;
}

/** Who made a call: the agent user whose socket it arrived on. */
export interface Caller {
	user: string;
}

/** Resolves a "cred:<name>" reference to a token, never logging it. */
export interface SecretStore {
	resolve(ref: string): string;
	/** Whether an optional credential is stored (non-empty). Never throws for a missing one. */
	has(ref: string): boolean;
}

/**
 * What a library call needs a credential for (design #175 §2a). `owner` is optional for
 * `kind: "npm"` (the npm token is not per-owner); `person` is the agent user the call
 * runs for — a resolver may ignore it (the daemon's catalog schema fetch does).
 */
export interface TokenRequest {
	person: string;
	owner?: string;
	mode: Mode;
	kind: "github" | "ghcr" | "npm";
}

/**
 * The library's ONLY credential path: resolved per call, never cached by the library,
 * and nothing token-shaped may appear in a result or an error. `null` = no access —
 * the library turns it into a typed error.
 */
export type TokenResolver = (req: TokenRequest) => Promise<string | null>;

/**
 * The person field's no-person marker (design #175 §2a/§2g): the catalog's schema fetch
 * is owner-independent — any valid read token works — so it requests a token with this
 * marker in TokenRequest.person and a resolver ignores it (the daemon's resolver does).
 * Not a valid agent user: agent users are non-empty names (src/agents.ts), so "" can
 * never collide with a real person.
 */
export const NO_PERSON = "";

/**
 * Structured audit log. One JSON line per decision/call to stdout (journald
 * captures it). NEVER include token values or OTP codes — only tool, owner, mode, repo, result.
 */
export interface AuditEntry {
	tool: string;
	/** The agent user whose socket the call came in on. */
	user?: string;
	owner?: string;
	mode?: "read" | "write";
	repo?: string;
	/** fork_repository only: the repo that was forked (owner/repo are the new copy). */
	source?: string;
	decision: "forward" | "custom" | "augment" | "deny" | "error";
	ok?: boolean;
	detail?: string;
	/** OTP gate outcome, on gated and hard-locked calls (src/otp/gate.ts). */
	otp?: "window" | "opened" | "refused" | "locked" | "hard-locked" | "lockout" | "hard-lock";
	/** When a window opened by this call closes, or when a short lockout started by it ends. */
	until?: string;
	/** Window id (an HMAC of the code under a per-process key), for window/opened. Never the code. */
	window?: string;
}

/**
 * A security-relevant OTP event, distinct from the per-call {@link AuditEntry}: the OTP
 * machine's audit surface is one optional sink carrying these (design #175 §2c). Type-only
 * for now — the slices that rebuild the gate and the router wire the sink.
 */
export type SecurityEvent =
	| { kind: "code-bad"; tool: string; person: string; failures: number }
	| { kind: "lock"; tool: string; person: string; until: string }
	| { kind: "hard-lock"; tool: string; person: string; since: string; lockouts: number }
	| { kind: "unlock"; person: string; by: string }
	| { kind: "refused-mode"; tool: string; person: string; mode: Mode }
	| { kind: "protected-write"; tool: string; person: string; detail: string };

/** The audit fields a gated (or hard-locked) call adds to its log line (src/otp/gate.ts). */
export type OtpOutcome = "window" | "opened" | "refused" | "locked" | "hard-locked";

export interface OtpAudit {
	otp: OtpOutcome;
	window?: string;
	/** When the window closes, on "opened". */
	until?: string;
}

/** A call the gate refused. Its message is safe to return to the agent. */
export class OtpRefusal extends Error {
	readonly audit: OtpAudit;
	constructor(message: string, audit: OtpAudit) {
		super(message);
		this.name = "OtpRefusal";
		this.audit = audit;
	}
}

/**
 * The OTP gate seam (design #175 §2e): what the Router consumes. The daemon's concrete
 * implementation is src/otp/gate.ts's OtpGate class (host code over @cldmv/lib-otp +
 * LockStateStore); the Router takes any implementation through its unchanged constructor.
 * Same name as the concrete class on purpose — the class structurally satisfies this.
 */
export interface OtpGate {
	/** Whether the gate is set up (config.otp + a stored, decodable seed). Inert when false. */
	enabled: boolean;
	/** The refusal that blocks every tool for a hard-locked user, or undefined. */
	hardLockRefusal(user: string): OtpRefusal | undefined;
	/** Check a gated call's code; throws OtpRefusal when the code is refused. */
	authorize(tool: string, code: unknown, user: string): OtpAudit;
	/** The otp_status payload for a user. */
	status(user: string): unknown;
}
